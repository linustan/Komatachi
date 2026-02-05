//! Komatachi CLI
//!
//! Interactive terminal that communicates with the Komatachi agent
//! running inside a Docker container via JSON-lines over stdin/stdout.

use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, BufReader, Write};
use std::process::{Command, Stdio};

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct InputMessage {
    r#type: &'static str,
    text: String,
}

#[derive(Deserialize)]
struct AgentMessage {
    r#type: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    let api_key = match std::env::var("ANTHROPIC_API_KEY") {
        Ok(key) if !key.is_empty() => key,
        _ => {
            eprintln!("error: ANTHROPIC_API_KEY environment variable is required");
            std::process::exit(1);
        }
    };

    // Resolve directories
    let data_dir = std::env::var("KOMATACHI_DATA_DIR")
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
            format!("{}/.komatachi/data", home)
        });
    let home_dir = std::env::var("KOMATACHI_HOME_DIR")
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
            format!("{}/.komatachi/home", home)
        });

    // Ensure directories exist
    std::fs::create_dir_all(&data_dir).unwrap_or_else(|e| {
        eprintln!("error: cannot create data dir {}: {}", data_dir, e);
        std::process::exit(1);
    });
    std::fs::create_dir_all(&home_dir).unwrap_or_else(|e| {
        eprintln!("error: cannot create home dir {}: {}", home_dir, e);
        std::process::exit(1);
    });

    // Build Docker image
    eprint!("Building Docker image...");
    let build_status = Command::new("docker")
        .args(["compose", "build", "app"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    match build_status {
        Ok(status) if status.success() => eprintln!(" done."),
        Ok(status) => {
            eprintln!(" failed (exit {}).", status);
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!(" failed: {}.", e);
            std::process::exit(1);
        }
    }

    // Collect optional env vars to pass through
    let mut env_args: Vec<String> = vec![
        format!("ANTHROPIC_API_KEY={}", api_key),
    ];
    for var in ["KOMATACHI_MODEL", "KOMATACHI_MAX_TOKENS", "KOMATACHI_CONTEXT_WINDOW"] {
        if let Ok(val) = std::env::var(var) {
            env_args.push(format!("{}={}", var, val));
        }
    }

    // Spawn Docker container
    let mut docker_args: Vec<&str> = vec!["run", "-i", "--rm"];
    for env_arg in &env_args {
        docker_args.push("-e");
        docker_args.push(env_arg);
    }
    docker_args.push("-v");
    let data_mount = format!("{}:/data", data_dir);
    docker_args.push(&data_mount);
    docker_args.push("-v");
    let home_mount = format!("{}:/home/agent", home_dir);
    docker_args.push(&home_mount);
    docker_args.push("komatachi-app");

    let mut child = Command::new("docker")
        .args(&docker_args)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap_or_else(|e| {
            eprintln!("error: failed to start Docker container: {}", e);
            std::process::exit(1);
        });

    let child_stdin = child.stdin.take().expect("child stdin");
    let child_stdout = child.stdout.take().expect("child stdout");

    let mut writer = io::BufWriter::new(child_stdin);
    let mut reader = BufReader::new(child_stdout);

    // Wait for ready signal
    let mut line = String::new();
    match reader.read_line(&mut line) {
        Ok(0) => {
            eprintln!("error: agent exited before sending ready signal");
            std::process::exit(1);
        }
        Ok(_) => {
            let msg: AgentMessage = serde_json::from_str(line.trim()).unwrap_or_else(|e| {
                eprintln!("error: invalid ready message: {}", e);
                std::process::exit(1);
            });
            if msg.r#type != "ready" {
                eprintln!("error: expected ready, got: {}", msg.r#type);
                std::process::exit(1);
            }
        }
        Err(e) => {
            eprintln!("error: reading from agent: {}", e);
            std::process::exit(1);
        }
    }

    eprintln!("Komatachi ready. Type 'quit' or 'exit' to stop.\n");

    // REPL loop
    let stdin = io::stdin();
    let mut input_buf = String::new();

    loop {
        eprint!("> ");
        io::stderr().flush().ok();

        input_buf.clear();
        match stdin.lock().read_line(&mut input_buf) {
            Ok(0) => break, // EOF
            Err(e) => {
                eprintln!("error: reading input: {}", e);
                break;
            }
            Ok(_) => {}
        }

        let input = input_buf.trim();
        if input.is_empty() {
            continue;
        }
        if input == "quit" || input == "exit" {
            break;
        }

        // Send input to agent
        let msg = InputMessage {
            r#type: "input",
            text: input.to_string(),
        };
        let json = serde_json::to_string(&msg).expect("serialize input");
        if writeln!(writer, "{}", json).is_err() {
            eprintln!("error: agent stdin closed");
            break;
        }
        if writer.flush().is_err() {
            eprintln!("error: flush to agent failed");
            break;
        }

        // Read response
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => {
                eprintln!("error: agent exited unexpectedly");
                break;
            }
            Ok(_) => {
                match serde_json::from_str::<AgentMessage>(line.trim()) {
                    Ok(msg) => match msg.r#type.as_str() {
                        "output" => {
                            if let Some(text) = msg.text {
                                println!("{}", text);
                            }
                        }
                        "error" => {
                            eprintln!(
                                "error: {}",
                                msg.message.as_deref().unwrap_or("unknown error")
                            );
                        }
                        other => {
                            eprintln!("warning: unexpected message type: {}", other);
                        }
                    },
                    Err(e) => {
                        eprintln!("error: invalid response from agent: {}", e);
                    }
                }
            }
            Err(e) => {
                eprintln!("error: reading from agent: {}", e);
                break;
            }
        }
    }

    // Clean up: drop writer closes stdin, Docker container exits
    drop(writer);
    let _ = child.wait();
}
