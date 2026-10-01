//! kwnote — the command-line companion of the MEMORY SUPPORT SYSTEM web app.

mod client;
mod codec;
mod model;
mod server;
mod store;
mod tui;

use std::io::{IsTerminal, Read};
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};

use crate::model::{Doc, Item, Record, Sentence, fmt_date, merge_docs, new_id, now_ms};

#[derive(Parser)]
#[command(
    name = "kwnote",
    version,
    about = "Spaced-repetition memory notes: vim-style TUI, LAN sync server and QR sync"
)]
struct Cli {
    /// Data file (default: $KWNOTE_DATA or <data dir>/kwnote/data.json)
    #[arg(long, global = true, value_name = "FILE")]
    data: Option<PathBuf>,

    /// Reference date for scheduling (YYYY-MM-DD, today, +N, -N)
    #[arg(long, global = true, value_name = "DATE", allow_hyphen_values = true)]
    date: Option<String>,

    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Open the review TUI (default when no command is given)
    Review,
    /// Register a record
    Add {
        #[command(subcommand)]
        what: AddCmd,
    },
    /// Print records due on the reference date (or all records)
    List {
        #[arg(short, long)]
        all: bool,
        #[arg(long)]
        json: bool,
    },
    /// Show counts: due today, due tomorrow, finished
    Stats,
    /// Show or set the four review intervals in days
    Settings {
        #[arg(num_args = 4, value_names = ["N1", "N2", "N3", "N4"])]
        n: Option<Vec<i64>>,
    },
    /// Write the data as JSON (same format as the web app's EXPORT)
    Export {
        #[arg(short, long)]
        output: Option<PathBuf>,
    },
    /// Merge a JSON export or a sync code (file or `-` for stdin)
    Import {
        file: String,
        /// Overwrite local data instead of merging
        #[arg(long)]
        replace: bool,
    },
    /// Print the text sync code (paste it into the web app's LOAD box)
    Code {
        #[arg(long, default_value_t = codec::DEFAULT_CHUNK)]
        chunk: usize,
    },
    /// Show the data as an animated QR sequence (scan it from the web app)
    Qr {
        #[arg(long, default_value_t = codec::DEFAULT_CHUNK)]
        chunk: usize,
    },
    /// Serve the web app + sync API on the local network
    Serve {
        #[arg(short, long, default_value_t = 7878)]
        port: u16,
        #[arg(long, default_value = "0.0.0.0")]
        bind: String,
        /// Allow sync without the pairing key (trusted networks only)
        #[arg(long)]
        no_auth: bool,
        /// Generate a new pairing key (devices must re-scan)
        #[arg(long)]
        regen_key: bool,
        /// Don't print the QR code for the URL
        #[arg(long)]
        no_qr: bool,
    },
    /// Two-way sync with another machine's `kwnote serve`
    Sync {
        /// e.g. http://192.168.1.20:7878 (remembered for next time)
        url: Option<String>,
        #[arg(long)]
        key: Option<String>,
    },
    /// Print the data file path
    Path,
}

#[derive(Subcommand)]
enum AddCmd {
    /// Question & answer (一問一答)
    #[command(visible_alias = "q")]
    Qa {
        question: String,
        answer: String,
        #[arg(short, long, default_value = "")]
        note: String,
    },
    /// Sentence to read (ぶんしょう)
    #[command(visible_alias = "s")]
    Sentence { text: String },
}

fn main() {
    if let Err(e) = run() {
        eprintln!("kwnote: {e:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    if let Some(p) = cli.data {
        store::set_data_path(p);
    }
    let today = match &cli.date {
        Some(d) => {
            model::parse_date_arg(d, model::today()).with_context(|| format!("bad --date {d:?}"))?
        }
        None => model::today(),
    };

    match cli.cmd.unwrap_or(Cmd::Review) {
        Cmd::Review => {
            if !std::io::stdout().is_terminal() {
                bail!("the review UI needs a terminal; try `kwnote list`");
            }
            tui::run(today, None)
        }
        Cmd::Add { what } => {
            let mut doc = store::load()?;
            let reg = fmt_date(today);
            match what {
                AddCmd::Qa {
                    question,
                    answer,
                    note,
                } => doc.items.push(Item {
                    id: new_id("id_"),
                    question,
                    answer,
                    note,
                    registered_date: reg.clone(),
                    updated_at: now_ms(),
                    ..Default::default()
                }),
                AddCmd::Sentence { text } => doc.sentences.push(Sentence {
                    id: new_id("s_"),
                    text,
                    registered_date: reg.clone(),
                    updated_at: now_ms(),
                    ..Default::default()
                }),
            }
            let doc = store::commit(&doc)?;
            let first = today + chrono::Duration::days(doc.settings.interval(1));
            println!("registered {reg} — first review {}", fmt_date(first));
            Ok(())
        }
        Cmd::List { all, json } => list(&store::load()?, today, all, json),
        Cmd::Stats => {
            let doc = store::load()?;
            let s = model::stats(&doc, today);
            println!("reference date : {}", fmt_date(today));
            println!("Q&A            : {} (due {})", s.items, s.due_items);
            println!("sentences      : {} (due {})", s.sentences, s.due_sentences);
            println!("due tomorrow   : {}", s.due_tomorrow);
            println!("all turns done : {}", s.finished);
            println!("intervals      : {:?}", doc.settings.n);
            Ok(())
        }
        Cmd::Settings { n } => {
            let mut doc = store::load()?;
            if let Some(n) = n {
                if n.iter().any(|x| *x < 0) {
                    bail!("intervals must be >= 0");
                }
                doc.settings.n = n;
                doc.settings.updated_at = now_ms();
                doc = store::commit(&doc)?;
            }
            let n = &doc.settings.n;
            for (i, d) in n.iter().enumerate() {
                println!("turn {}: {d} day(s) after registering", i + 1);
            }
            Ok(())
        }
        Cmd::Export { output } => {
            let json = serde_json::to_string_pretty(&store::load()?)?;
            match output {
                Some(p) => {
                    std::fs::write(&p, json).with_context(|| format!("write {}", p.display()))
                }
                None => {
                    println!("{json}");
                    Ok(())
                }
            }
        }
        Cmd::Import { file, replace } => {
            let text = if file == "-" {
                let mut s = String::new();
                std::io::stdin().read_to_string(&mut s)?;
                s
            } else {
                std::fs::read_to_string(&file).with_context(|| format!("read {file}"))?
            };
            let incoming = codec::decode_any(&text)?;
            let doc = if replace {
                store::replace(&incoming)?;
                incoming
            } else {
                store::commit(&merge_docs(&store::load()?, &incoming))?
            };
            println!(
                "{} — {} Q&A, {} sentences",
                if replace { "replaced" } else { "merged" },
                doc.items.iter().filter(|r| !r.deleted).count(),
                doc.sentences.iter().filter(|r| !r.deleted).count()
            );
            Ok(())
        }
        Cmd::Code { chunk } => {
            for f in codec::frames(&store::load()?, chunk)? {
                println!("{f}");
            }
            Ok(())
        }
        Cmd::Qr { chunk } => {
            if !std::io::stdout().is_terminal() {
                bail!("`kwnote qr` needs a terminal; use `kwnote code` for text");
            }
            tui::run(today, Some(chunk))
        }
        Cmd::Serve {
            port,
            bind,
            no_auth,
            regen_key,
            no_qr,
        } => server::serve(&bind, port, !no_auth, regen_key, !no_qr),
        Cmd::Sync { url, key } => {
            let remote = client::resolve_remote(url.as_deref(), key.as_deref())?;
            let doc = client::sync(&store::load()?, &remote)?;
            println!(
                "synced with {} — {} Q&A, {} sentences",
                remote.url,
                doc.items.iter().filter(|r| !r.deleted).count(),
                doc.sentences.iter().filter(|r| !r.deleted).count()
            );
            Ok(())
        }
        Cmd::Path => {
            println!("{}", store::data_path().display());
            Ok(())
        }
    }
}

fn list(doc: &Doc, today: chrono::NaiveDate, all: bool, json: bool) -> Result<()> {
    fn rows<R: Record>(
        v: &[R],
        doc: &Doc,
        today: chrono::NaiveDate,
        all: bool,
    ) -> Vec<(R, Option<(u8, chrono::NaiveDate)>)> {
        v.iter()
            .filter(|r| !r.deleted())
            .filter_map(|r| {
                let next = model::next_turn(r, &doc.settings);
                if all || model::due_turn(r, &doc.settings, today).is_some() {
                    Some((r.clone(), next))
                } else {
                    None
                }
            })
            .collect()
    }
    let items = rows(&doc.items, doc, today, all);
    let sentences = rows(&doc.sentences, doc, today, all);
    if json {
        let out = serde_json::json!({
            "date": fmt_date(today),
            "items": items.iter().map(|(r, n)| serde_json::json!({
                "id": r.id, "question": r.question, "answer": r.answer, "note": r.note,
                "turn": n.map(|x| x.0), "scheduled": n.map(|x| fmt_date(x.1)),
            })).collect::<Vec<_>>(),
            "sentences": sentences.iter().map(|(r, n)| serde_json::json!({
                "id": r.id, "text": r.text,
                "turn": n.map(|x| x.0), "scheduled": n.map(|x| fmt_date(x.1)),
            })).collect::<Vec<_>>(),
        });
        println!("{}", serde_json::to_string_pretty(&out)?);
        return Ok(());
    }
    let tag = |n: &Option<(u8, chrono::NaiveDate)>| match n {
        Some((t, d)) => format!("T{t} {}", fmt_date(*d)),
        None => "done".into(),
    };
    println!("== Sentences ({}) ==", sentences.len());
    for (s, n) in &sentences {
        println!("  [{}] {}", tag(n), s.text);
    }
    println!("== Q&A ({}) ==", items.len());
    for (it, n) in &items {
        let note = if it.note.is_empty() {
            String::new()
        } else {
            format!("  ({})", it.note)
        };
        println!("  [{}] {}  →  {}{note}", tag(n), it.question, it.answer);
    }
    Ok(())
}
