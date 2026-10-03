//! kwnote — the command-line companion of the MEMORY SUPPORT SYSTEM web app.

mod client;
mod codec;
mod model;
mod server;
mod store;
mod tui;
mod update;

use std::io::{IsTerminal, Read};
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};

use crate::model::{Doc, Item, Record, Sentence, fmt_date, merge_docs, new_id, now_ms};

const QR_TRADEMARK: &str = "QR Code is a registered trademark of DENSO WAVE INCORPORATED.";

#[derive(Parser)]
#[command(
    name = "kwnote",
    version,
    about = "Spaced-repetition memory notes: vim-style TUI, LAN sync server and QR sync",
    after_help = QR_TRADEMARK
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
    /// Show or change the settings: intervals (one per turn), order, daily cap
    Settings {
        /// Days after registering for each turn, 1 to 20 values (e.g. 1 3 7 14 30)
        #[arg(value_name = "DAYS", num_args = 1..=model::MAX_TURNS)]
        n: Option<Vec<i64>>,
        /// Use preset intervals: standard, dense, long, daily
        #[arg(short, long, value_name = "NAME", conflicts_with = "n")]
        preset: Option<String>,
        /// Number of turns: cuts the list, or extends it by doubling the last interval
        #[arg(short, long, value_name = "N", conflicts_with_all = ["n", "preset"])]
        turns: Option<usize>,
        /// Order of today's list: random, due, oldest, newest
        #[arg(short, long, value_name = "ORDER")]
        order: Option<String>,
        /// Daily cap of today's list per pane (0 = none)
        #[arg(short, long, value_name = "N")]
        limit: Option<usize>,
    },
    /// Write the data as JSON (same format as the web app's SAVE FILE)
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
    /// Print the text sync code (paste it into the web app's PASTE CODE dialog)
    Code {
        #[arg(long, default_value_t = codec::DEFAULT_CHUNK)]
        chunk: usize,
    },
    /// Show the data as an animated QR sequence (scan it from the web app)
    #[command(after_help = QR_TRADEMARK)]
    Qr {
        #[arg(long, default_value_t = codec::DEFAULT_CHUNK)]
        chunk: usize,
    },
    /// Serve the web app + sync API on the local network
    #[command(after_help = QR_TRADEMARK)]
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
    /// Print the licenses of the third-party crates built into kwnote
    Licenses,
    /// Update kwnote to the latest GitHub release (checksum-verified)
    Update {
        /// Only check whether a newer release exists
        #[arg(long)]
        check: bool,
        /// Reinstall even if already up to date
        #[arg(long)]
        force: bool,
        /// Install a specific release tag (e.g. v1.0.0)
        #[arg(long, value_name = "TAG")]
        tag: Option<String>,
    },
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
            println!("settings       : {}", doc.settings.describe());
            Ok(())
        }
        Cmd::Settings {
            n,
            preset,
            turns,
            order,
            limit,
        } => {
            let mut doc = store::load()?;
            let mut s = doc.settings.clone();
            if let Some(n) = n {
                s.n = n;
            }
            if let Some(p) = preset {
                let names: Vec<&str> = model::PRESETS.iter().map(|p| p.0).collect();
                s.n = model::preset(&p)
                    .with_context(|| format!("unknown preset {p:?} (use {})", names.join(", ")))?
                    .to_vec();
            }
            if let Some(t) = turns {
                if !(1..=model::MAX_TURNS).contains(&t) {
                    bail!("--turns must be 1 to {}", model::MAX_TURNS);
                }
                while s.n.len() < t {
                    let last = s.n.last().copied().unwrap_or(1);
                    s.n.push((last * 2).max(last + 1));
                }
                s.n.truncate(t);
            }
            if let Some(o) = order {
                s.set_order(model::Order::parse(&o).with_context(|| {
                    format!("unknown order {o:?} (random, due, oldest, newest)")
                })?);
            }
            if let Some(l) = limit {
                s.set_limit(l);
            }
            if s != doc.settings {
                model::check_intervals(&s.n).map_err(anyhow::Error::msg)?;
                s.updated_at = model::next_stamp(doc.settings.updated_at);
                doc.settings = s;
                doc = store::commit(&doc)?;
            }
            let s = &doc.settings;
            for (i, d) in s.n.iter().enumerate() {
                println!("turn {:>2}: {d} day(s) after registering", i + 1);
            }
            println!("order  : {}", s.order().as_str());
            match s.limit() {
                0 => println!("limit  : none"),
                l => println!("limit  : {l} per day (each of Sentences / Q&A)"),
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
        Cmd::Update { check, force, tag } => update::run(check, force, tag.as_deref()),
        Cmd::Licenses => {
            // long text, usually piped into a pager: a closed pipe is fine
            use std::io::Write;
            let text = include_str!(concat!(env!("OUT_DIR"), "/licenses.txt"));
            let _ = std::io::stdout().write_all(text.as_bytes());
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
