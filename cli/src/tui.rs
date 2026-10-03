//! Full-screen review UI with vim-style key bindings.
//! (The web app deliberately uses only the original j / k / Enter / c so it
//! does not collide with browser extensions such as Vimium; the terminal UI
//! keeps the full vim-style map. Keep `HELP` in step with README.)

use std::collections::HashSet;
use std::io::stdout;
use std::time::{Duration, Instant, SystemTime};

use anyhow::Result;
use chrono::NaiveDate;
use crossterm::event::{
    self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyCode, KeyEvent, KeyEventKind,
    KeyModifiers,
};
use crossterm::execute;
use ratatui::Frame;
use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style, Stylize};
use ratatui::text::{Line as TLine, Span};
use ratatui::widgets::{Block, BorderType, Cell, Clear, Paragraph, Row, Table, TableState, Wrap};
use unicode_width::UnicodeWidthStr;

use crate::client;
use crate::codec::{self, QrBlock};
use crate::model::{
    self, Doc, Item, Record, Sentence, fmt_date, merge_docs, new_id, next_turn, toggle_turn,
};
use crate::store;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Pane {
    Sentences = 0,
    Qa = 1,
}

impl Pane {
    fn other(self) -> Pane {
        match self {
            Pane::Sentences => Pane::Qa,
            Pane::Qa => Pane::Sentences,
        }
    }
    fn label(self) -> &'static str {
        match self {
            Pane::Sentences => "今日のぶんしょう Sentences",
            Pane::Qa => "今日のもんだい Q&A",
        }
    }
}

const XP_BLUE: Color = Color::Rgb(0x0c, 0x4e, 0xd5);

// same palette as --turnN-bg in style.css; turns past 8 keep the 8th colour
fn turn_color(t: u8) -> Color {
    match t {
        1 => Color::Rgb(0x6f, 0x9c, 0xe8),
        2 => Color::Rgb(0x6c, 0xc0, 0x7a),
        3 => Color::Rgb(0xe0, 0xc0, 0x4c),
        4 => Color::Rgb(0xe8, 0x8a, 0x5c),
        5 => Color::Rgb(0xb0, 0x8c, 0xe0),
        6 => Color::Rgb(0xe0, 0x82, 0xb4),
        7 => Color::Rgb(0x5c, 0xc0, 0xc0),
        _ => Color::Rgb(0xa0, 0xa8, 0x70),
    }
}

fn find<'a, R: Record>(v: &'a [R], id: &str) -> Option<&'a R> {
    v.iter().find(|r| r.id() == id && !r.deleted())
}

fn find_mut<'a, R: Record>(v: &'a mut [R], id: &str) -> Option<&'a mut R> {
    v.iter_mut().find(|r| r.id() == id)
}

fn mask(s: &str) -> String {
    "＝".repeat(s.chars().count().min(40))
}

// ---------------------------------------------------------------- line input

#[derive(Default, Clone, Debug)]
struct LineInput {
    buf: Vec<char>,
    cur: usize,
}

impl LineInput {
    fn from(s: &str) -> Self {
        let buf: Vec<char> = s.chars().collect();
        LineInput {
            cur: buf.len(),
            buf,
        }
    }
    fn text(&self) -> String {
        self.buf.iter().collect()
    }
    fn insert_str(&mut self, s: &str) {
        for c in s.chars().filter(|c| !c.is_control()) {
            self.buf.insert(self.cur, c);
            self.cur += 1;
        }
    }
    /// Emacs/readline-ish editing, as in vim's insert & command-line modes.
    fn edit(&mut self, k: KeyEvent) -> bool {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        match (k.code, ctrl) {
            (KeyCode::Home, _) | (KeyCode::Char('a'), true) => self.cur = 0,
            (KeyCode::End, _) | (KeyCode::Char('e'), true) => self.cur = self.buf.len(),
            (KeyCode::Left, _) | (KeyCode::Char('b'), true) => {
                self.cur = self.cur.saturating_sub(1)
            }
            (KeyCode::Right, _) | (KeyCode::Char('f'), true) => {
                self.cur = (self.cur + 1).min(self.buf.len())
            }
            (KeyCode::Backspace, _) | (KeyCode::Char('h'), true) => {
                if self.cur > 0 {
                    self.cur -= 1;
                    self.buf.remove(self.cur);
                }
            }
            (KeyCode::Delete, _) | (KeyCode::Char('d'), true) => {
                if self.cur < self.buf.len() {
                    self.buf.remove(self.cur);
                }
            }
            (KeyCode::Char('u'), true) => {
                self.buf.drain(..self.cur);
                self.cur = 0;
            }
            (KeyCode::Char('k'), true) => self.buf.truncate(self.cur),
            (KeyCode::Char('w'), true) => {
                let mut i = self.cur;
                while i > 0 && self.buf[i - 1].is_whitespace() {
                    i -= 1;
                }
                while i > 0 && !self.buf[i - 1].is_whitespace() {
                    i -= 1;
                }
                self.buf.drain(i..self.cur);
                self.cur = i;
            }
            (KeyCode::Char(c), false) => {
                self.buf.insert(self.cur, c);
                self.cur += 1;
            }
            _ => return false,
        }
        true
    }
    /// The visible slice for a field `width` columns wide, and the cursor
    /// column inside it.
    fn view(&self, width: usize) -> (String, u16) {
        let width = width.max(2);
        let mut start = 0;
        let w = |a: usize, b: usize| -> usize { self.buf[a..b].iter().collect::<String>().width() };
        while w(start, self.cur) >= width {
            start += 1;
        }
        let mut end = self.cur;
        while end < self.buf.len() && w(start, end + 1) < width {
            end += 1;
        }
        (
            self.buf[start..end].iter().collect(),
            w(start, self.cur) as u16,
        )
    }
}

// ---------------------------------------------------------------- modes

struct Form {
    pane: Pane,
    edit: Option<String>,
    fields: Vec<(&'static str, LineInput)>,
    focus: usize,
}

/// QR speeds in frames per second (same steps as RATES in ../../sync.js).
/// Shown as a rate, not as an interval in ms: "faster" then makes the number
/// go up instead of down.
const QR_RATES: [f64; 10] = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0];
const QR_DEFAULT_RATE: usize = 4;

struct QrView {
    blocks: Vec<QrBlock>,
    idx: usize,
    paused: bool,
    /// index into QR_RATES
    rate: usize,
    last: Instant,
}

impl QrView {
    fn interval(&self) -> Duration {
        Duration::from_secs_f64(1.0 / QR_RATES[self.rate])
    }
}

/// 2.5 -> "2.5", 3.0 -> "3"
fn short_num(x: f64) -> String {
    let r = (x * 10.0).round() / 10.0;
    if r.fract() == 0.0 {
        format!("{r:.0}")
    } else {
        format!("{r:.1}")
    }
}

enum Mode {
    Normal,
    Insert(Form),
    Command(LineInput),
    Search(LineInput),
    Help(u16),
    ConfirmDelete(Pane, String),
    Qr(QrView),
}

enum Snapshot {
    Item(Item),
    Sentence(Sentence),
}

#[derive(Default)]
struct PaneState {
    due: Vec<(String, u8)>,
    all: bool,
    sel: usize,
    table: TableState,
}

struct RowRef {
    id: String,
    turn: Option<u8>,
    sched: Option<NaiveDate>,
}

pub struct App {
    doc: Doc,
    today: NaiveDate,
    panes: [PaneState; 2],
    focus: Pane,
    mode: Mode,
    revealed: HashSet<String>,
    pending: Option<char>,
    count: Option<usize>,
    undo: Vec<Snapshot>,
    last_search: Option<String>,
    msg: String,
    msg_err: bool,
    mtime: Option<SystemTime>,
    last_poll: Instant,
    page: usize,
    quit: bool,
    qr_only: bool,
    /// the date today's lists were built for
    list_date: Option<NaiveDate>,
    /// keep today's lists in today.json (off in tests)
    persist: bool,
}

const HELP: &[(&str, &str)] = &[
    ("移動 Move", ""),
    ("j / k  ↓ / ↑", "next / previous row (count: 5j)"),
    ("gg / G", "first / last row (count: 3G = row 3)"),
    ("Ctrl-d / Ctrl-u", "half page down / up"),
    (
        "h / l  Tab",
        "switch pane: Sentences ⇄ Q&A (also Ctrl-w w/j/k)",
    ),
    ("復習 Review", ""),
    ("Enter / Space / za", "show / hide the answer"),
    ("zR / zM", "show all / hide all answers"),
    ("c", "OK — mark this turn done (again = undo it)"),
    ("u", "undo the last change (mark, edit, delete)"),
    ("r", "reshuffle today's list (same rows)"),
    ("t", "toggle view: Today ⇄ All records"),
    ("編集 Edit", ""),
    (
        "o / a / i",
        "register a new record in the current pane (insert mode)",
    ),
    ("e", "edit the selected record"),
    ("dd", "delete the selected record (asks y/N)"),
    (
        "/pattern  n / N",
        "search in the current pane, next / previous",
    ),
    (
        "Insert mode",
        "Tab/Shift-Tab ↑↓ field · Enter next/save · Esc cancel",
    ),
    ("", "Ctrl-a/e home/end · Ctrl-u/k/w kill · Ctrl-b/f move"),
    ("同期 Sync", ""),
    ("s", "sync with the saved remote (kwnote serve)"),
    (":qr", "show the animated sync QR (scan from the web app)"),
    ("コマンド :commands", ""),
    (
        ":q  :w  :wq",
        "quit / save (data is saved after every change)",
    ),
    (
        ":sync [url] [key]",
        "sync with another machine's `kwnote serve`",
    ),
    (":date YYYY-MM-DD|+N|-N|today", "change the reference date"),
    (
        ":set n=1,3,7,14,30",
        "intervals in days, one per turn (1–20 turns; n5=30 adds/edits one)",
    ),
    (
        ":set turns=6  preset=long",
        "number of turns · presets: standard dense long daily",
    ),
    (
        ":set order=due  limit=20",
        "today's order: random due oldest newest · daily cap (0 = none)",
    ),
    (":set", "show the current settings"),
    (
        ":all  :today  :stats  :e!",
        "view all / today · statistics · reload from disk",
    ),
    ("?", "this help · q / Esc closes"),
];

impl App {
    pub fn new(doc: Doc, today: NaiveDate) -> App {
        let mut app = App {
            doc,
            today,
            panes: Default::default(),
            focus: Pane::Qa,
            mode: Mode::Normal,
            revealed: HashSet::new(),
            pending: None,
            count: None,
            undo: Vec::new(),
            last_search: None,
            msg: String::new(),
            msg_err: false,
            mtime: store::mtime(),
            last_poll: Instant::now(),
            page: 10,
            quit: false,
            qr_only: false,
            list_date: None,
            persist: false,
        };
        app.refresh();
        if app.rows(Pane::Qa).is_empty() && !app.rows(Pane::Sentences).is_empty() {
            app.focus = Pane::Sentences;
        }
        app
    }

    // ------------------------------------------------------------ data

    fn info(&mut self, s: impl Into<String>) {
        self.msg = s.into();
        self.msg_err = false;
    }

    fn error(&mut self, s: impl Into<String>) {
        self.msg = s.into();
        self.msg_err = true;
    }

    fn save(&mut self) {
        match store::commit(&self.doc) {
            Ok(d) => {
                self.doc = d;
                self.mtime = store::mtime();
            }
            Err(e) => self.error(format!("save failed: {e:#}")),
        }
        self.reconcile();
    }

    /// Rebuild today's lists, like the web app's refreshDueList(): a new
    /// order (per `settings.order`), filled up to `settings.limit`. Rows
    /// already finished today stay and keep counting toward the cap.
    fn refresh(&mut self) {
        let same_day = self.list_date == Some(self.today);
        let carry: [Vec<(String, u8)>; 2] = [Pane::Sentences, Pane::Qa].map(|p| {
            if !same_day {
                return vec![];
            }
            self.panes[p as usize]
                .due
                .iter()
                .filter(|e| {
                    let row = RowRef {
                        id: e.0.clone(),
                        turn: Some(e.1),
                        sched: None,
                    };
                    self.is_done_today(p, &row)
                })
                .cloned()
                .collect()
        });
        self.build(carry);
        self.select_first_open();
        self.revealed.clear();
    }

    /// Start each pane on its first unfinished row.
    fn select_first_open(&mut self) {
        for p in [Pane::Sentences, Pane::Qa] {
            let rows = self.rows(p);
            let first = rows.iter().position(|r| !self.is_done(p, r)).unwrap_or(0);
            self.panes[p as usize].sel = first;
        }
    }

    /// After a save/sync: keep the current lists and their order, drop
    /// deleted records and append anything that became due (within the cap).
    fn reconcile(&mut self) {
        let carry = [Pane::Sentences, Pane::Qa].map(|p| self.panes[p as usize].due.clone());
        self.build(carry);
        for p in [Pane::Sentences, Pane::Qa] {
            let n = self.rows(p).len();
            let ps = &mut self.panes[p as usize];
            ps.sel = ps.sel.min(n.saturating_sub(1));
        }
    }

    fn build(&mut self, carry: [Vec<(String, u8)>; 2]) {
        let d = &self.doc;
        let [cs, cq] = carry;
        self.panes[Pane::Sentences as usize].due =
            model::build_today(&d.sentences, &d.settings, self.today, &cs);
        self.panes[Pane::Qa as usize].due =
            model::build_today(&d.items, &d.settings, self.today, &cq);
        self.list_date = Some(self.today);
        self.save_today();
    }

    fn settings_sig(&self) -> String {
        let s = &self.doc.settings;
        format!("{:?}|{}|{}", s.n, s.order().as_str(), s.limit())
    }

    fn save_today(&self) {
        if !self.persist {
            return;
        }
        store::save_today(&store::TodayState {
            data: store::data_path().display().to_string(),
            date: fmt_date(self.today),
            sig: self.settings_sig(),
            sentences: self.panes[Pane::Sentences as usize].due.clone(),
            qa: self.panes[Pane::Qa as usize].due.clone(),
        });
    }

    /// Pick up today's lists from the last run (same data file and date):
    /// as they were if the settings are unchanged, else rebuilt keeping the
    /// rows already finished.
    pub fn restore_today(&mut self, saved: Option<store::TodayState>) {
        self.persist = true;
        match saved {
            Some(t) => self.apply_saved(t),
            None => self.save_today(),
        }
    }

    fn apply_saved(&mut self, t: store::TodayState) {
        if t.date != fmt_date(self.today) {
            return self.save_today();
        }
        self.panes[Pane::Sentences as usize].due = t.sentences;
        self.panes[Pane::Qa as usize].due = t.qa;
        if t.sig == self.settings_sig() {
            self.reconcile();
        } else {
            self.refresh();
        }
        self.select_first_open();
    }

    fn poll_disk(&mut self) {
        if self.last_poll.elapsed() < Duration::from_secs(1) {
            return;
        }
        self.last_poll = Instant::now();
        let m = store::mtime();
        if m.is_some() && m != self.mtime {
            self.mtime = m;
            match store::load() {
                Ok(disk) => {
                    self.doc = merge_docs(&self.doc, &disk);
                    self.reconcile();
                    self.info("data file changed on disk — merged");
                }
                Err(e) => self.error(format!("reload failed: {e:#}")),
            }
        }
    }

    fn rows(&self, pane: Pane) -> Vec<RowRef> {
        let ps = &self.panes[pane as usize];
        let exists = |id: &str| match pane {
            Pane::Sentences => find(&self.doc.sentences, id).is_some(),
            Pane::Qa => find(&self.doc.items, id).is_some(),
        };
        if !ps.all {
            return ps
                .due
                .iter()
                .filter(|(id, _)| exists(id))
                .map(|(id, t)| RowRef {
                    id: id.clone(),
                    turn: Some(*t),
                    sched: None,
                })
                .collect();
        }
        let s = &self.doc.settings;
        let mut v: Vec<(RowRef, String)> = match pane {
            Pane::Sentences => self
                .doc
                .sentences
                .iter()
                .filter(|r| !r.deleted)
                .map(|r| (r.id.clone(), next_turn(r, s), r.registered_date.clone()))
                .collect::<Vec<_>>(),
            Pane::Qa => self
                .doc
                .items
                .iter()
                .filter(|r| !r.deleted)
                .map(|r| (r.id.clone(), next_turn(r, s), r.registered_date.clone()))
                .collect(),
        }
        .into_iter()
        .map(|(id, next, reg)| {
            (
                RowRef {
                    id,
                    turn: next.map(|n| n.0),
                    sched: next.map(|n| n.1),
                },
                reg,
            )
        })
        .collect();
        v.sort_by(|(a, ra), (b, rb)| match (a.sched, b.sched) {
            (Some(x), Some(y)) => x.cmp(&y).then(ra.cmp(rb)),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => ra.cmp(rb),
        });
        v.into_iter().map(|(r, _)| r).collect()
    }

    fn is_done(&self, pane: Pane, row: &RowRef) -> bool {
        if row.turn.is_some() && self.panes[pane as usize].all {
            return false;
        }
        self.is_done_today(pane, row)
    }

    /// Whether the row's turn is completed (today's-list semantics).
    fn is_done_today(&self, pane: Pane, row: &RowRef) -> bool {
        let Some(t) = row.turn else { return true };
        match pane {
            Pane::Sentences => {
                find(&self.doc.sentences, &row.id).is_some_and(|r| r.completed_turns.contains(&t))
            }
            Pane::Qa => {
                find(&self.doc.items, &row.id).is_some_and(|r| r.completed_turns.contains(&t))
            }
        }
    }

    fn selected(&self) -> Option<RowRef> {
        let rows = self.rows(self.focus);
        let sel = self.panes[self.focus as usize].sel;
        rows.into_iter().nth(sel)
    }

    fn select_id(&mut self, pane: Pane, id: &str) {
        if let Some(i) = self.rows(pane).iter().position(|r| r.id == id) {
            self.panes[pane as usize].sel = i;
        }
    }

    fn haystack(&self, pane: Pane, id: &str) -> String {
        match pane {
            Pane::Sentences => find(&self.doc.sentences, id).map(|r| r.haystack()),
            Pane::Qa => find(&self.doc.items, id).map(|r| r.haystack()),
        }
        .unwrap_or_default()
        .to_lowercase()
    }

    // ------------------------------------------------------------ actions

    fn move_to(&mut self, idx: isize) {
        let n = self.rows(self.focus).len();
        if n == 0 {
            return;
        }
        self.panes[self.focus as usize].sel = idx.clamp(0, n as isize - 1) as usize;
    }

    fn move_by(&mut self, d: isize) {
        let cur = self.panes[self.focus as usize].sel as isize;
        self.move_to(cur + d);
    }

    fn toggle_reveal(&mut self) {
        if self.focus != Pane::Qa {
            return self.info("sentences have no hidden part — press c when you have read it");
        }
        if let Some(r) = self.selected()
            && !self.revealed.remove(&r.id)
        {
            self.revealed.insert(r.id);
        }
    }

    fn mark_ok(&mut self) {
        let pane = self.focus;
        if self.panes[pane as usize].all {
            return self.error("c works in the Today view (press t)");
        }
        let Some(row) = self.selected() else { return };
        let Some(turn) = row.turn else { return };
        let done = match pane {
            Pane::Qa => find_mut(&mut self.doc.items, &row.id).map(|r| {
                self.undo.push(Snapshot::Item(r.clone()));
                toggle_turn(r, turn)
            }),
            Pane::Sentences => find_mut(&mut self.doc.sentences, &row.id).map(|r| {
                self.undo.push(Snapshot::Sentence(r.clone()));
                toggle_turn(r, turn)
            }),
        };
        let Some(done) = done else { return };
        self.save();
        if done {
            self.info(format!("OK — turn {turn} done"));
            // autofocus the nearest unfinished row (previous first), like the web app
            let rows = self.rows(pane);
            let cur = self.panes[pane as usize].sel;
            for d in 1..rows.len() {
                if cur >= d && !self.is_done(pane, &rows[cur - d]) {
                    self.panes[pane as usize].sel = cur - d;
                    break;
                }
                if cur + d < rows.len() && !self.is_done(pane, &rows[cur + d]) {
                    self.panes[pane as usize].sel = cur + d;
                    break;
                }
            }
        } else {
            self.info(format!("turn {turn} un-done"));
        }
    }

    fn undo(&mut self) {
        let Some(snap) = self.undo.pop() else {
            return self.info("Already at oldest change");
        };
        let (pane, id) = match snap {
            Snapshot::Item(mut it) => {
                let id = it.id.clone();
                let cur = find_mut(&mut self.doc.items, &id).map_or(0, |r| r.updated_at);
                it.updated_at = model::next_stamp(cur.max(it.updated_at));
                match find_mut(&mut self.doc.items, &id) {
                    Some(r) => *r = it,
                    None => self.doc.items.push(it),
                }
                (Pane::Qa, id)
            }
            Snapshot::Sentence(mut s) => {
                let id = s.id.clone();
                let cur = find_mut(&mut self.doc.sentences, &id).map_or(0, |r| r.updated_at);
                s.updated_at = model::next_stamp(cur.max(s.updated_at));
                match find_mut(&mut self.doc.sentences, &id) {
                    Some(r) => *r = s,
                    None => self.doc.sentences.push(s),
                }
                (Pane::Sentences, id)
            }
        };
        self.save();
        self.focus = pane;
        self.select_id(pane, &id);
        self.info(format!("undone ({} more)", self.undo.len()));
    }

    fn delete(&mut self, pane: Pane, id: &str) {
        match pane {
            Pane::Qa => {
                if let Some(r) = find_mut(&mut self.doc.items, id) {
                    self.undo.push(Snapshot::Item(r.clone()));
                    r.deleted = true;
                    r.touch();
                }
            }
            Pane::Sentences => {
                if let Some(r) = find_mut(&mut self.doc.sentences, id) {
                    self.undo.push(Snapshot::Sentence(r.clone()));
                    r.deleted = true;
                    r.touch();
                }
            }
        }
        self.save();
        self.info("deleted (u to undo)");
    }

    fn open_form(&mut self, pane: Pane, edit: Option<String>) {
        let today = fmt_date(model::today());
        let fields = match pane {
            Pane::Qa => {
                let it = edit
                    .as_deref()
                    .and_then(|id| find(&self.doc.items, id))
                    .cloned()
                    .unwrap_or_default();
                vec![
                    ("Question", LineInput::from(&it.question)),
                    ("Answer", LineInput::from(&it.answer)),
                    ("Supplement", LineInput::from(&it.note)),
                    (
                        "Registering date",
                        LineInput::from(if edit.is_some() {
                            &it.registered_date
                        } else {
                            &today
                        }),
                    ),
                ]
            }
            Pane::Sentences => {
                let s = edit
                    .as_deref()
                    .and_then(|id| find(&self.doc.sentences, id))
                    .cloned()
                    .unwrap_or_default();
                vec![
                    ("Sentence", LineInput::from(&s.text)),
                    (
                        "Registering date",
                        LineInput::from(if edit.is_some() {
                            &s.registered_date
                        } else {
                            &today
                        }),
                    ),
                ]
            }
        };
        self.mode = Mode::Insert(Form {
            pane,
            edit,
            fields,
            focus: 0,
        });
    }

    /// Returns false (and keeps the form open) when validation fails.
    fn submit(&mut self, form: &Form) -> bool {
        let v: Vec<String> = form
            .fields
            .iter()
            .map(|(_, l)| l.text().trim().to_string())
            .collect();
        let date_txt = v.last().cloned().unwrap_or_default();
        let Some(date) = model::parse_date_arg(&date_txt, self.today) else {
            self.error(format!("bad date {date_txt:?} (YYYY-MM-DD, today, +N, -N)"));
            return false;
        };
        let date = fmt_date(date);
        let id = match form.pane {
            Pane::Qa => {
                if v[0].is_empty() || v[1].is_empty() {
                    self.error("Question and Answer are required");
                    return false;
                }
                match form
                    .edit
                    .as_deref()
                    .and_then(|id| find_mut(&mut self.doc.items, id))
                {
                    Some(r) => {
                        self.undo.push(Snapshot::Item(r.clone()));
                        (r.question, r.answer, r.note) = (v[0].clone(), v[1].clone(), v[2].clone());
                        r.registered_date = date.clone();
                        r.touch();
                        r.id.clone()
                    }
                    None => {
                        let it = Item {
                            id: new_id("id_"),
                            question: v[0].clone(),
                            answer: v[1].clone(),
                            note: v[2].clone(),
                            registered_date: date.clone(),
                            updated_at: model::now_ms(),
                            ..Default::default()
                        };
                        let id = it.id.clone();
                        self.doc.items.push(it);
                        id
                    }
                }
            }
            Pane::Sentences => {
                if v[0].is_empty() {
                    self.error("Sentence is required");
                    return false;
                }
                match form
                    .edit
                    .as_deref()
                    .and_then(|id| find_mut(&mut self.doc.sentences, id))
                {
                    Some(r) => {
                        self.undo.push(Snapshot::Sentence(r.clone()));
                        r.text = v[0].clone();
                        r.registered_date = date.clone();
                        r.touch();
                        r.id.clone()
                    }
                    None => {
                        let s = Sentence {
                            id: new_id("s_"),
                            text: v[0].clone(),
                            registered_date: date.clone(),
                            updated_at: model::now_ms(),
                            ..Default::default()
                        };
                        let id = s.id.clone();
                        self.doc.sentences.push(s);
                        id
                    }
                }
            }
        };
        self.save();
        self.select_id(form.pane, &id);
        let first = model::parse_date(&date).unwrap_or(self.today)
            + chrono::Duration::days(self.doc.settings.interval(1));
        if form.edit.is_some() {
            self.info("updated");
        } else {
            self.info(format!("registered — first review {}", fmt_date(first)));
        }
        true
    }

    fn search(&mut self, forward: bool) {
        let Some(pat) = self.last_search.clone().map(|p| p.to_lowercase()) else {
            return self.error("no previous search pattern");
        };
        let rows = self.rows(self.focus);
        let n = rows.len();
        let cur = self.panes[self.focus as usize].sel;
        for step in 1..=n {
            let i = if forward {
                (cur + step) % n
            } else {
                (cur + n * 2 - step) % n
            };
            if self.haystack(self.focus, &rows[i].id).contains(&pat) {
                self.panes[self.focus as usize].sel = i;
                if step == n {
                    self.info(format!("/{pat}  (only match)"));
                } else if (forward && i <= cur) || (!forward && i >= cur) {
                    self.info(format!("/{pat}  search hit BOTTOM, continuing at TOP"));
                } else {
                    self.info(format!("/{pat}"));
                }
                return;
            }
        }
        self.error(format!("Pattern not found: {pat}"));
    }

    fn sync(&mut self, url: Option<&str>, key: Option<&str>) {
        let res = client::resolve_remote(url, key)
            .and_then(|r| client::sync(&self.doc, &r).map(|d| (d, r)));
        match res {
            Ok((doc, r)) => {
                self.doc = doc;
                self.mtime = store::mtime();
                self.reconcile();
                self.info(format!("synced with {}", r.url));
            }
            Err(e) => self.error(format!("sync failed: {e:#}")),
        }
    }

    pub fn open_qr(&mut self, chunk: usize) -> Result<()> {
        let frames = codec::frames(&self.doc, chunk)?;
        let blocks = frames
            .iter()
            .map(|f| QrBlock::new(f))
            .collect::<Result<Vec<_>>>()?;
        self.mode = Mode::Qr(QrView {
            blocks,
            idx: 0,
            paused: false,
            rate: QR_DEFAULT_RATE,
            last: Instant::now(),
        });
        Ok(())
    }

    fn run_command(&mut self, cmd: &str) {
        let mut parts = cmd.split_whitespace();
        let Some(head) = parts.next() else { return };
        let args: Vec<&str> = parts.collect();
        match head {
            "q" | "q!" | "qa" | "qa!" | "wq" | "x" | "quit" => self.quit = true,
            "w" | "write" => {
                self.save();
                if !self.msg_err {
                    self.info(format!("\"{}\" written", store::data_path().display()));
                }
            }
            "e!" | "edit!" | "reload" => match store::load() {
                Ok(d) => {
                    self.doc = d;
                    self.refresh();
                    self.info("reloaded");
                }
                Err(e) => self.error(format!("{e:#}")),
            },
            "sync" => self.sync(args.first().copied(), args.get(1).copied()),
            "date" => {
                match model::parse_date_arg(args.first().copied().unwrap_or("today"), self.today) {
                    Some(d) => {
                        self.today = d;
                        self.refresh();
                        self.info(format!("reference date {}", fmt_date(d)));
                    }
                    None => self.error("usage: :date YYYY-MM-DD | today | +N | -N"),
                }
            }
            "set" => self.set_option(&args.join(" ")),
            "qr" => {
                let chunk = args
                    .first()
                    .and_then(|a| a.parse().ok())
                    .unwrap_or(codec::DEFAULT_CHUNK);
                if let Err(e) = self.open_qr(chunk) {
                    self.error(format!("{e:#}"));
                }
            }
            "all" => self.panes.iter_mut().for_each(|p| p.all = true),
            "today" => self.panes.iter_mut().for_each(|p| p.all = false),
            "stats" => {
                let s = model::stats(&self.doc, self.today);
                self.info(format!(
                    "Q&A {} (due {}) · Sentences {} (due {}) · finished {} · due tomorrow {}",
                    s.items, s.due_items, s.sentences, s.due_sentences, s.finished, s.due_tomorrow
                ));
            }
            "h" | "help" => self.mode = Mode::Help(0),
            _ => self.error(format!("E492: Not an editor command: {cmd}")),
        }
    }

    fn set_option(&mut self, arg: &str) {
        const USAGE: &str = "usage: :set n=1,3,7,14,30 · n5=30 · preset=long · order=random|due|oldest|newest · limit=20";
        if arg.trim().is_empty() {
            return self.info(self.doc.settings.describe());
        }
        let mut s = self.doc.settings.clone();
        for opt in arg.split_whitespace() {
            let Some((k, v)) = opt.split_once('=') else {
                return self.error(USAGE);
            };
            let ok = match k {
                "n" => match v.split(',').map(|x| x.trim().parse().ok()).collect() {
                    Some(n) => {
                        s.n = n;
                        true
                    }
                    None => false,
                },
                // nN=days changes one turn; n(len+1)=days adds a turn
                k if k.starts_with('n') && k.len() > 1 => {
                    match (k[1..].parse::<usize>(), v.trim().parse::<i64>()) {
                        (Ok(i), Ok(d)) if i >= 1 && i <= s.n.len() => {
                            s.n[i - 1] = d;
                            true
                        }
                        (Ok(i), Ok(d)) if i == s.n.len() + 1 => {
                            s.n.push(d);
                            true
                        }
                        _ => false,
                    }
                }
                "turns" => match v.trim().parse::<usize>() {
                    // more turns repeat the last interval doubled
                    Ok(t) if (1..=model::MAX_TURNS).contains(&t) => {
                        while s.n.len() < t {
                            let last = s.n.last().copied().unwrap_or(1);
                            s.n.push((last * 2).max(last + 1));
                        }
                        s.n.truncate(t);
                        true
                    }
                    _ => false,
                },
                "preset" => match model::preset(v) {
                    Some(n) => {
                        s.n = n.to_vec();
                        true
                    }
                    None => false,
                },
                "order" => match model::Order::parse(v) {
                    Some(o) => {
                        s.set_order(o);
                        true
                    }
                    None => false,
                },
                "limit" => match v.trim().parse() {
                    Ok(n) => {
                        s.set_limit(n);
                        true
                    }
                    Err(_) => false,
                },
                _ => false,
            };
            if !ok {
                return self.error(USAGE);
            }
        }
        if let Err(e) = model::check_intervals(&s.n) {
            return self.error(e);
        }
        s.updated_at = model::next_stamp(self.doc.settings.updated_at);
        self.doc.settings = s;
        self.save();
        self.refresh();
        self.info(format!("set {}", self.doc.settings.describe()));
    }

    // ------------------------------------------------------------ keys

    pub fn on_paste(&mut self, s: &str) {
        match &mut self.mode {
            Mode::Insert(form) => {
                let f = form.focus;
                form.fields[f].1.insert_str(s);
            }
            Mode::Command(l) | Mode::Search(l) => l.insert_str(s),
            _ => {}
        }
    }

    pub fn on_key(&mut self, k: KeyEvent) {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        let mode = std::mem::replace(&mut self.mode, Mode::Normal);
        self.mode = match mode {
            Mode::Normal => {
                self.normal_key(k);
                return;
            }
            Mode::Help(scroll) => match k.code {
                KeyCode::Char('j') | KeyCode::Down => Mode::Help(scroll.saturating_add(1)),
                KeyCode::Char('k') | KeyCode::Up => Mode::Help(scroll.saturating_sub(1)),
                KeyCode::Char('q') | KeyCode::Char('?') | KeyCode::Esc | KeyCode::Enter => {
                    Mode::Normal
                }
                _ => Mode::Help(scroll),
            },
            Mode::ConfirmDelete(pane, id) => {
                if matches!(k.code, KeyCode::Char('y') | KeyCode::Char('Y')) {
                    self.delete(pane, &id);
                } else {
                    self.info("cancelled");
                }
                Mode::Normal
            }
            Mode::Command(mut line) => match k.code {
                KeyCode::Esc => Mode::Normal,
                KeyCode::Char('c') if ctrl => Mode::Normal,
                KeyCode::Backspace if line.buf.is_empty() => Mode::Normal,
                KeyCode::Enter => {
                    self.run_command(line.text().trim());
                    // run_command may have switched mode (help, qr)
                    return;
                }
                _ => {
                    line.edit(k);
                    Mode::Command(line)
                }
            },
            Mode::Search(mut line) => match k.code {
                KeyCode::Esc => Mode::Normal,
                KeyCode::Char('c') if ctrl => Mode::Normal,
                KeyCode::Backspace if line.buf.is_empty() => Mode::Normal,
                KeyCode::Enter => {
                    let t = line.text();
                    if !t.is_empty() {
                        self.last_search = Some(t);
                    }
                    self.search(true);
                    Mode::Normal
                }
                _ => {
                    line.edit(k);
                    Mode::Search(line)
                }
            },
            Mode::Insert(mut form) => {
                let last = form.fields.len() - 1;
                match k.code {
                    KeyCode::Esc => {
                        self.info("cancelled");
                        Mode::Normal
                    }
                    KeyCode::Char('c') if ctrl => Mode::Normal,
                    KeyCode::Tab | KeyCode::Down => {
                        form.focus = (form.focus + 1) % form.fields.len();
                        Mode::Insert(form)
                    }
                    KeyCode::Char('n') if ctrl => {
                        form.focus = (form.focus + 1) % form.fields.len();
                        Mode::Insert(form)
                    }
                    KeyCode::BackTab | KeyCode::Up => {
                        form.focus = (form.focus + last) % form.fields.len();
                        Mode::Insert(form)
                    }
                    KeyCode::Char('p') if ctrl => {
                        form.focus = (form.focus + last) % form.fields.len();
                        Mode::Insert(form)
                    }
                    // Enter moves to the next field; on the last (date) field
                    // or the first required one being the only one, it saves.
                    KeyCode::Enter if form.focus < last && !ctrl => {
                        form.focus += 1;
                        Mode::Insert(form)
                    }
                    KeyCode::Enter => {
                        if self.submit(&form) {
                            Mode::Normal
                        } else {
                            Mode::Insert(form)
                        }
                    }
                    _ => {
                        let f = form.focus;
                        form.fields[f].1.edit(k);
                        Mode::Insert(form)
                    }
                }
            }
            Mode::Qr(mut q) => match k.code {
                KeyCode::Char('q') | KeyCode::Esc => {
                    if self.qr_only {
                        self.quit = true;
                    }
                    Mode::Normal
                }
                KeyCode::Char(' ') => {
                    q.paused = !q.paused;
                    Mode::Qr(q)
                }
                KeyCode::Char('l') | KeyCode::Right | KeyCode::Char('j') => {
                    q.idx = (q.idx + 1) % q.blocks.len();
                    q.paused = true;
                    Mode::Qr(q)
                }
                KeyCode::Char('h') | KeyCode::Left | KeyCode::Char('k') => {
                    q.idx = (q.idx + q.blocks.len() - 1) % q.blocks.len();
                    q.paused = true;
                    Mode::Qr(q)
                }
                KeyCode::Char('+') | KeyCode::Char('=') => {
                    q.rate = (q.rate + 1).min(QR_RATES.len() - 1);
                    Mode::Qr(q)
                }
                KeyCode::Char('-') => {
                    q.rate = q.rate.saturating_sub(1);
                    Mode::Qr(q)
                }
                _ => Mode::Qr(q),
            },
        };
    }

    fn normal_key(&mut self, k: KeyEvent) {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        if let Some(p) = self.pending.take() {
            let count = self.count.take();
            match (p, k.code) {
                ('g', KeyCode::Char('g')) => {
                    self.move_to(count.map(|c| c as isize - 1).unwrap_or(0))
                }
                ('d', KeyCode::Char('d')) => {
                    if let Some(r) = self.selected() {
                        self.mode = Mode::ConfirmDelete(self.focus, r.id);
                    }
                }
                ('z', KeyCode::Char('a')) => self.toggle_reveal(),
                ('z', KeyCode::Char('R')) => {
                    for r in self.rows(Pane::Qa) {
                        self.revealed.insert(r.id);
                    }
                }
                ('z', KeyCode::Char('M')) => self.revealed.clear(),
                ('w', KeyCode::Char('w' | 'j' | 'k' | 'p') | KeyCode::Down | KeyCode::Up) => {
                    self.focus = self.focus.other()
                }
                _ => {}
            }
            return;
        }
        if let KeyCode::Char(c @ '0'..='9') = k.code
            && !ctrl
            && (c != '0' || self.count.is_some())
        {
            self.count = Some(
                self.count
                    .unwrap_or(0)
                    .saturating_mul(10)
                    .saturating_add(c as usize - '0' as usize),
            );
            return;
        }
        let count = self.count.take();
        let n = count.unwrap_or(1) as isize;
        self.msg.clear();
        match (k.code, ctrl) {
            (KeyCode::Char('c'), true) => self.quit = true,
            (KeyCode::Char('j') | KeyCode::Down, false) | (KeyCode::Char('n'), true) => {
                self.move_by(n)
            }
            (KeyCode::Char('k') | KeyCode::Up, false) | (KeyCode::Char('p'), true) => {
                self.move_by(-n)
            }
            (KeyCode::Char('d'), true) => self.move_by((self.page as isize / 2).max(1) * n),
            (KeyCode::Char('u'), true) => self.move_by(-(self.page as isize / 2).max(1) * n),
            (KeyCode::Char('f'), true) | (KeyCode::PageDown, _) => {
                self.move_by(self.page.max(1) as isize * n)
            }
            (KeyCode::Char('b'), true) | (KeyCode::PageUp, _) => {
                self.move_by(-(self.page.max(1) as isize) * n)
            }
            (KeyCode::Char('w'), true) => self.pending = Some('w'),
            (KeyCode::Char('G'), _) | (KeyCode::End, _) => match count {
                Some(c) => self.move_to(c as isize - 1),
                None => self.move_to(isize::MAX / 2),
            },
            (KeyCode::Home, _) => self.move_to(0),
            (KeyCode::Char(c @ ('g' | 'd' | 'z')), false) => {
                self.pending = Some(c);
                self.count = count;
            }
            (KeyCode::Char('h' | 'l'), false) | (KeyCode::Tab | KeyCode::BackTab, _) => {
                self.focus = self.focus.other()
            }
            (KeyCode::Left, _) => self.focus = Pane::Sentences,
            (KeyCode::Right, _) => self.focus = Pane::Qa,
            (KeyCode::Enter | KeyCode::Char(' '), _) => self.toggle_reveal(),
            (KeyCode::Char('c' | 'C'), false) => self.mark_ok(),
            (KeyCode::Char('u'), false) => self.undo(),
            (KeyCode::Char('o' | 'O' | 'a' | 'A' | 'i' | 'I'), false) => {
                self.open_form(self.focus, None)
            }
            (KeyCode::Char('e'), false) => match self.selected() {
                Some(r) => self.open_form(self.focus, Some(r.id)),
                None => self.error("nothing selected"),
            },
            (KeyCode::Char('x'), false) => {
                if let Some(r) = self.selected() {
                    self.mode = Mode::ConfirmDelete(self.focus, r.id);
                }
            }
            (KeyCode::Char('r'), false) => {
                // only reorders: the same rows, so the daily cap still holds
                for ps in &mut self.panes {
                    model::shuffle(&mut ps.due);
                    ps.sel = 0;
                }
                self.save_today();
                self.info("reshuffled");
            }
            (KeyCode::Char('t'), false) => {
                let ps = &mut self.panes[self.focus as usize];
                ps.all = !ps.all;
                ps.sel = 0;
            }
            (KeyCode::Char('/'), false) => self.mode = Mode::Search(LineInput::default()),
            (KeyCode::Char('n'), false) => self.search(true),
            (KeyCode::Char('N'), false) => self.search(false),
            (KeyCode::Char(':'), false) => self.mode = Mode::Command(LineInput::default()),
            (KeyCode::Char('?'), false) | (KeyCode::F(1), _) => self.mode = Mode::Help(0),
            (KeyCode::Char('s'), false) => self.sync(None, None),
            (KeyCode::Char('q'), false) => self.quit = true,
            (KeyCode::Esc, _) => {}
            _ => {}
        }
    }

    pub fn tick(&mut self) {
        if let Mode::Qr(q) = &mut self.mode {
            if !q.paused && q.last.elapsed() >= q.interval() {
                q.idx = (q.idx + 1) % q.blocks.len();
                q.last = Instant::now();
            }
        } else {
            self.poll_disk();
        }
    }

    // ------------------------------------------------------------ drawing

    fn draw(&mut self, f: &mut Frame) {
        if let Mode::Qr(q) = &self.mode {
            draw_qr(f, q);
            return;
        }
        let area = f.area();
        let s_rows = self.rows(Pane::Sentences).len() as u16;
        let s_height = (s_rows + 3).clamp(4, (area.height.saturating_sub(12)) / 2 + 3);
        let [top, sent, qa, detail, status] = Layout::vertical([
            Constraint::Length(1),
            Constraint::Length(s_height),
            Constraint::Min(5),
            Constraint::Length(6),
            Constraint::Length(1),
        ])
        .areas(area);

        self.draw_title(f, top);
        self.draw_pane(f, sent, Pane::Sentences);
        self.draw_pane(f, qa, Pane::Qa);
        self.draw_detail(f, detail);
        self.draw_status(f, status);

        match &self.mode {
            Mode::Help(scroll) => draw_help(f, *scroll),
            Mode::Insert(form) => draw_form(f, form),
            Mode::ConfirmDelete(..) => {
                let r = centered(f.area(), 44, 5);
                f.render_widget(Clear, r);
                f.render_widget(
                    Paragraph::new("Delete this record?  y / N")
                        .alignment(Alignment::Center)
                        .block(
                            Block::bordered()
                                .border_type(BorderType::Double)
                                .title(" confirm ")
                                .red(),
                        ),
                    r,
                );
            }
            _ => {}
        }
    }

    fn draw_title(&self, f: &mut Frame, r: Rect) {
        let views = |p: Pane| {
            if self.panes[p as usize].all {
                "All"
            } else {
                "Today"
            }
        };
        let left = Span::styled(
            " ◆ MEMORY SUPPORT SYSTEM ",
            Style::new().bold().fg(Color::White),
        );
        let right = Span::raw(format!(
            "ref {}  ·  S:{} Q:{}  ",
            fmt_date(self.today),
            views(Pane::Sentences),
            views(Pane::Qa)
        ));
        f.render_widget(
            Paragraph::new(TLine::from(left))
                .bg(XP_BLUE)
                .fg(Color::White),
            r,
        );
        f.render_widget(
            Paragraph::new(TLine::from(right))
                .alignment(Alignment::Right)
                .fg(Color::White),
            r,
        );
    }

    fn draw_pane(&mut self, f: &mut Frame, area: Rect, pane: Pane) {
        let rows = self.rows(pane);
        let focused = self.focus == pane;
        let all = self.panes[pane as usize].all;
        let done = rows.iter().filter(|r| self.is_done(pane, r)).count();
        let title = if all {
            format!(" {} — all {} ", pane.label(), rows.len())
        } else {
            format!(" {} — {}/{} done ", pane.label(), done, rows.len())
        };
        let border = if focused {
            Style::new().fg(Color::Cyan).bold()
        } else {
            Style::new().fg(Color::DarkGray)
        };
        let block = Block::bordered()
            .border_type(if focused {
                BorderType::Thick
            } else {
                BorderType::Plain
            })
            .border_style(border)
            .title(title);

        if rows.is_empty() {
            let msg = if all {
                "- None -  (o to register)"
            } else {
                "- None -  nothing due today 🎉  (t: all records)"
            };
            f.render_widget(Paragraph::new(msg).dark_gray().block(block), area);
            return;
        }

        let turn_w = if all { 12 } else { 4 };
        let mut table_rows = Vec::with_capacity(rows.len());
        for row in &rows {
            let is_done = self.is_done(pane, row);
            let turn_cell = match (row.turn, row.sched) {
                (Some(t), Some(d)) if all => {
                    let txt = format!("T{t} {}", d.format("%m/%d"));
                    let st = if d <= self.today {
                        Style::new().fg(turn_color(t)).bold()
                    } else {
                        Style::new().fg(turn_color(t))
                    };
                    Cell::from(txt).style(st)
                }
                (Some(t), _) => {
                    Cell::from(format!(" T{t}")).style(Style::new().fg(turn_color(t)).bold())
                }
                (None, _) => Cell::from(" ✓ done").style(Style::new().fg(Color::DarkGray)),
            };
            let mut cells = vec![turn_cell];
            match pane {
                Pane::Sentences => {
                    let s = find(&self.doc.sentences, &row.id)
                        .map(|s| s.text.clone())
                        .unwrap_or_default();
                    cells.push(Cell::from(s));
                }
                Pane::Qa => {
                    let it = find(&self.doc.items, &row.id).cloned().unwrap_or_default();
                    let shown = all || self.revealed.contains(&row.id);
                    cells.push(Cell::from(it.question.clone()));
                    if shown {
                        cells.push(Cell::from(it.answer.clone()));
                        cells.push(Cell::from(it.note.clone()));
                    } else {
                        cells.push(
                            Cell::from(mask(&it.answer)).style(Style::new().fg(Color::DarkGray)),
                        );
                        cells.push(Cell::from(""));
                    }
                }
            }
            let mut r = Row::new(cells);
            if is_done && !all {
                r = r.style(
                    Style::new()
                        .fg(Color::DarkGray)
                        .add_modifier(Modifier::CROSSED_OUT),
                );
            }
            table_rows.push(r);
        }
        let header_style = Style::new().bold().underlined();
        let (header, widths) = match pane {
            Pane::Sentences => (
                Row::new(vec!["Turn", "Sentences"]).style(header_style),
                vec![Constraint::Length(turn_w), Constraint::Fill(1)],
            ),
            Pane::Qa => (
                Row::new(vec!["Turn", "Que.", "Ans.", "Sup."]).style(header_style),
                vec![
                    Constraint::Length(turn_w),
                    Constraint::Percentage(36),
                    Constraint::Percentage(30),
                    Constraint::Fill(1),
                ],
            ),
        };
        let hl = if focused {
            Style::new()
                .bg(XP_BLUE)
                .fg(Color::White)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::new().bg(Color::Rgb(0x30, 0x30, 0x40))
        };
        let table = Table::new(table_rows, widths)
            .header(header)
            .block(block)
            .row_highlight_style(hl)
            .highlight_symbol(if focused { "▶" } else { " " })
            .column_spacing(1);
        if focused {
            self.page = area.height.saturating_sub(3) as usize;
        }
        let ps = &mut self.panes[pane as usize];
        ps.sel = ps.sel.min(rows.len() - 1);
        ps.table.select(Some(ps.sel));
        f.render_stateful_widget(table, area, &mut ps.table);
    }

    fn draw_detail(&self, f: &mut Frame, area: Rect) {
        let block = Block::bordered()
            .border_style(Style::new().fg(Color::DarkGray))
            .title(" detail ");
        let Some(row) = self.selected() else {
            f.render_widget(Paragraph::new("").block(block), area);
            return;
        };
        let label = |s: &'static str| Span::styled(s, Style::new().fg(Color::Cyan).bold());
        let mut lines: Vec<TLine> = Vec::new();
        let (reg, turns) = match self.focus {
            Pane::Sentences => {
                let Some(s) = find(&self.doc.sentences, &row.id) else {
                    return;
                };
                lines.push(TLine::from(vec![label("S "), Span::raw(s.text.clone())]));
                (s.registered_date.clone(), s.completed_turns.clone())
            }
            Pane::Qa => {
                let Some(it) = find(&self.doc.items, &row.id) else {
                    return;
                };
                let shown = self.panes[1].all || self.revealed.contains(&row.id);
                lines.push(TLine::from(vec![
                    label("Q "),
                    Span::raw(it.question.clone()),
                ]));
                if shown {
                    lines.push(TLine::from(vec![
                        label("A "),
                        Span::raw(it.answer.clone()).bold(),
                    ]));
                    if !it.note.is_empty() {
                        lines.push(TLine::from(vec![label("+ "), Span::raw(it.note.clone())]));
                    }
                } else {
                    lines.push(TLine::from(vec![
                        label("A "),
                        Span::raw("(Enter で表示 / Enter to reveal)").dark_gray(),
                    ]));
                }
                (it.registered_date.clone(), it.completed_turns.clone())
            }
        };
        let turns_txt: Vec<String> = (1..=self.doc.settings.turns().max(1))
            .map(|t| {
                if turns.contains(&t) {
                    format!("■{t}")
                } else {
                    format!("□{t}")
                }
            })
            .collect();
        lines.push(
            TLine::from(format!(
                "registered {reg}  ·  turns {}",
                turns_txt.join(" ")
            ))
            .style(Style::new().fg(Color::DarkGray)),
        );
        f.render_widget(
            Paragraph::new(lines)
                .wrap(Wrap { trim: false })
                .block(block),
            area,
        );
    }

    fn draw_status(&self, f: &mut Frame, area: Rect) {
        let (label, color) = match &self.mode {
            Mode::Insert(_) => ("INSERT", Color::Green),
            Mode::Command(_) | Mode::Search(_) => ("COMMAND", Color::Yellow),
            _ => ("NORMAL", XP_BLUE),
        };
        match &self.mode {
            Mode::Command(l) | Mode::Search(l) => {
                let prefix = if matches!(self.mode, Mode::Command(_)) {
                    ":"
                } else {
                    "/"
                };
                let (txt, cx) = l.view(area.width.saturating_sub(2) as usize);
                f.render_widget(Paragraph::new(format!("{prefix}{txt}")), area);
                f.set_cursor_position((area.x + 1 + cx, area.y));
            }
            _ => {
                let mut spans = vec![
                    Span::styled(
                        format!(" {label} "),
                        Style::new().bg(color).fg(Color::White).bold(),
                    ),
                    Span::raw(" "),
                ];
                if !self.msg.is_empty() {
                    let st = if self.msg_err {
                        Style::new().fg(Color::White).bg(Color::Red)
                    } else {
                        Style::new()
                    };
                    spans.push(Span::styled(self.msg.clone(), st));
                } else {
                    spans.push(Span::styled(
                        "j/k move · Enter show · c OK · u undo · o add · : cmd · ? help",
                        Style::new().fg(Color::DarkGray),
                    ));
                }
                f.render_widget(Paragraph::new(TLine::from(spans)), area);
                let mut pend = String::new();
                if let Some(c) = self.count {
                    pend.push_str(&c.to_string());
                }
                if let Some(p) = self.pending {
                    pend.push(if p == 'w' { '^' } else { p });
                    if p == 'w' {
                        pend.push('W');
                    }
                }
                f.render_widget(
                    Paragraph::new(format!("{pend}  ")).alignment(Alignment::Right),
                    area,
                );
            }
        }
    }
}

fn centered(area: Rect, w: u16, h: u16) -> Rect {
    let w = w.min(area.width);
    let h = h.min(area.height);
    Rect {
        x: area.x + (area.width - w) / 2,
        y: area.y + (area.height - h) / 2,
        width: w,
        height: h,
    }
}

fn draw_help(f: &mut Frame, scroll: u16) {
    let area = centered(f.area(), 84, f.area().height.saturating_sub(2));
    let mut lines: Vec<TLine> = HELP
        .iter()
        .map(|(k, v)| {
            if v.is_empty() {
                TLine::from(Span::styled(*k, Style::new().fg(Color::Cyan).bold()))
            } else {
                TLine::from(vec![
                    Span::styled(format!("  {k:<30}"), Style::new().bold()),
                    Span::raw(*v),
                ])
            }
        })
        .collect();
    lines.push(TLine::from(""));
    lines.push(TLine::from(
        "QR Code is a registered trademark of DENSO WAVE INCORPORATED.".dark_gray(),
    ));
    f.render_widget(Clear, area);
    f.render_widget(
        Paragraph::new(lines).scroll((scroll, 0)).block(
            Block::bordered()
                .border_type(BorderType::Double)
                .title(" kwnote keys — j/k scroll · q close ")
                .fg(Color::White),
        ),
        area,
    );
}

fn draw_form(f: &mut Frame, form: &Form) {
    let h = form.fields.len() as u16 * 2 + 4;
    let area = centered(f.area(), 76, h);
    let title = match (form.pane, form.edit.is_some()) {
        (Pane::Qa, false) => " Registering: Q&A ",
        (Pane::Qa, true) => " Editing: Q&A ",
        (Pane::Sentences, false) => " Registering: Sentence ",
        (Pane::Sentences, true) => " Editing: Sentence ",
    };
    let block = Block::bordered()
        .border_type(BorderType::Double)
        .title(title)
        .title_bottom(TLine::from(" Tab next · Enter next/save · Esc cancel ").right_aligned());
    let inner = block.inner(area);
    f.render_widget(Clear, area);
    f.render_widget(block.fg(Color::White), area);
    let field_w = inner.width.saturating_sub(2) as usize;
    for (i, (label, line)) in form.fields.iter().enumerate() {
        let y = inner.y + i as u16 * 2;
        if y + 1 >= inner.y + inner.height {
            break;
        }
        let focused = i == form.focus;
        let lab = Span::styled(
            *label,
            if focused {
                Style::new().fg(Color::Cyan).bold()
            } else {
                Style::new().fg(Color::Gray)
            },
        );
        f.render_widget(
            Paragraph::new(TLine::from(lab)),
            Rect {
                x: inner.x,
                y,
                width: inner.width,
                height: 1,
            },
        );
        let (txt, cx) = line.view(field_w);
        let st = if focused {
            Style::new().bg(Color::Rgb(0x26, 0x2a, 0x3a))
        } else {
            Style::new().bg(Color::Rgb(0x1c, 0x1c, 0x24))
        };
        let r = Rect {
            x: inner.x + 1,
            y: y + 1,
            width: inner.width.saturating_sub(2),
            height: 1,
        };
        f.render_widget(Paragraph::new(txt).style(st), r);
        if focused {
            f.set_cursor_position((r.x + cx, r.y));
        }
    }
}

fn draw_qr(f: &mut Frame, q: &QrView) {
    let area = f.area();
    let block = &q.blocks[q.idx];
    let need_w = block.width() as u16;
    let need_h = block.height_lines() as u16 + 2;
    let n = q.blocks.len();
    let speed = if n > 1 {
        let r = QR_RATES[q.rate];
        format!(
            "  ·  {} frames/s, all {n} in ~{} s",
            short_num(r),
            short_num(n as f64 / r)
        )
    } else {
        String::new()
    };
    let caption = format!(
        " frame {}/{n}{}{speed}  ·  space pause · h/l step · + faster · - slower · q close ",
        q.idx + 1,
        if q.paused { " (paused)" } else { "" },
    );
    if area.width < need_w || area.height < need_h {
        let msg = format!(
            "Terminal too small for this QR code: need {need_w}x{need_h}, have {}x{}.\n\
             Enlarge the window / zoom out, or use a smaller chunk: `:qr 200` / `kwnote qr --chunk 200`.\n\n{caption}",
            area.width, area.height
        );
        f.render_widget(Paragraph::new(msg).wrap(Wrap { trim: false }), area);
        return;
    }
    let qr_area = centered(
        Rect {
            height: area.height - 2,
            ..area
        },
        need_w,
        need_h - 2,
    );
    let style = Style::new().fg(Color::Indexed(16)).bg(Color::Indexed(231));
    let lines: Vec<TLine> = block
        .lines()
        .into_iter()
        .map(|l| TLine::styled(l, style))
        .collect();
    f.render_widget(Paragraph::new(lines), qr_area);
    let cap = Rect {
        x: area.x,
        y: area.y + area.height - 2,
        width: area.width,
        height: 2,
    };
    f.render_widget(
        Paragraph::new(vec![
            TLine::from(caption).centered(),
            TLine::from(
                "Web app → SCAN QR (Sync) で読み取り / scan from the web app's Sync section",
            )
            .centered()
            .dark_gray(),
        ]),
        cap,
    );
}

pub fn run(today: NaiveDate, qr_chunk: Option<usize>) -> Result<()> {
    let mut app = App::new(store::load()?, today);
    app.restore_today(store::load_today());
    if let Some(chunk) = qr_chunk {
        app.open_qr(chunk)?;
        app.qr_only = true;
    }
    let mut terminal = ratatui::init();
    let _ = execute!(stdout(), EnableBracketedPaste);
    let res: Result<()> = (|| {
        while !app.quit {
            terminal.draw(|f| app.draw(f))?;
            if event::poll(Duration::from_millis(80))? {
                match event::read()? {
                    Event::Key(k) if k.kind != KeyEventKind::Release => app.on_key(k),
                    Event::Paste(s) => app.on_paste(&s),
                    _ => {}
                }
            }
            app.tick();
        }
        Ok(())
    })();
    let _ = execute!(stdout(), DisableBracketedPaste);
    ratatui::restore();
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(c: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)
    }

    fn app_with(n: usize) -> App {
        let mut doc = Doc::default();
        for i in 0..n {
            doc.items.push(Item {
                id: format!("id_{i}"),
                question: format!("question {i}"),
                answer: format!("answer {i}"),
                registered_date: "2026-01-01".into(),
                ..Default::default()
            });
        }
        App::new(doc, model::parse_date("2026-01-02").unwrap())
    }

    /// Tests that save share one temp data file (the path can be set only
    /// once per process): run them one at a time, each from an empty file.
    fn temp_data() -> std::sync::MutexGuard<'static, ()> {
        static DISK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let guard = DISK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("kwnote-tui-{}", std::process::id()));
        store::set_data_path(dir.join("data.json"));
        let _ = std::fs::remove_file(store::data_path());
        guard
    }

    fn press(a: &mut App, code: KeyCode) {
        a.on_key(KeyEvent::new(code, KeyModifiers::NONE));
    }

    fn screen(a: &mut App) -> String {
        let backend = ratatui::backend::TestBackend::new(100, 32);
        let mut t = ratatui::Terminal::new(backend).unwrap();
        t.draw(|f| a.draw(f)).unwrap();
        let buf = t.backend().buffer().clone();
        let mut s = String::new();
        for y in 0..buf.area.height {
            for x in 0..buf.area.width {
                s.push_str(buf[(x, y)].symbol());
            }
            s.push('\n');
        }
        s
    }

    /// Drives a whole review session through the real key handler and
    /// renderer (writes go to a temp data file).
    #[test]
    fn review_session_end_to_end() {
        let _disk = temp_data();
        let dir = std::env::temp_dir().join(format!("kwnote-tui-{}", std::process::id()));
        let mut doc = Doc::default();
        doc.items.push(Item {
            id: "tui_q".into(),
            question: "capital of France".into(),
            answer: "Paris".into(),
            note: "city".into(),
            registered_date: "2026-01-01".into(),
            ..Default::default()
        });
        doc.sentences.push(Sentence {
            id: "tui_s".into(),
            text: "Read me aloud".into(),
            registered_date: "2026-01-01".into(),
            ..Default::default()
        });
        let mut a = App::new(doc, model::parse_date("2026-01-02").unwrap());

        let s = screen(&mut a);
        assert!(s.contains("MEMORY SUPPORT SYSTEM"));
        assert!(s.contains("capital of France") && s.contains("Read me aloud"));
        assert!(!s.contains("Paris"), "answer must start hidden");

        press(&mut a, KeyCode::Enter);
        assert!(screen(&mut a).contains("Paris"));

        a.on_key(key('c'));
        assert_eq!(a.doc.items[0].completed_turns, vec![1]);
        assert!(screen(&mut a).contains("1/1 done"));
        a.on_key(key('u'));
        assert!(a.doc.items[0].completed_turns.is_empty());

        a.on_key(key('h'));
        assert_eq!(a.focus, Pane::Sentences);
        a.on_key(key('c'));
        assert_eq!(a.doc.sentences[0].completed_turns, vec![1]);

        // o → insert mode, type, Enter to the date field, Enter to save
        a.on_key(key('o'));
        assert!(matches!(a.mode, Mode::Insert(_)));
        assert!(screen(&mut a).contains("Registering: Sentence"));
        for c in "brand new".chars() {
            a.on_key(key(c));
        }
        press(&mut a, KeyCode::Enter);
        press(&mut a, KeyCode::Enter);
        assert!(matches!(a.mode, Mode::Normal));
        assert!(a.doc.sentences.iter().any(|s| s.text == "brand new"));

        // dd asks, y deletes (tombstone), u restores
        a.on_key(key('k'));
        a.on_key(key('d'));
        a.on_key(key('d'));
        assert!(matches!(a.mode, Mode::ConfirmDelete(..)));
        a.on_key(key('y'));
        assert_eq!(a.doc.sentences.iter().filter(|s| s.deleted).count(), 1);
        a.on_key(key('u'));
        assert_eq!(a.doc.sentences.iter().filter(|s| s.deleted).count(), 0);

        // :qr shows the animated QR, q returns, :q quits
        for c in ":qr".chars() {
            a.on_key(key(c));
        }
        press(&mut a, KeyCode::Enter);
        assert!(matches!(a.mode, Mode::Qr(_)));
        let s = screen(&mut a);
        assert!(s.contains("frame 1/") || s.contains("Terminal too small"));
        a.on_key(key('q'));
        assert!(matches!(a.mode, Mode::Normal));
        for c in ":set n=2,4,8,16".chars() {
            a.on_key(key(c));
        }
        press(&mut a, KeyCode::Enter);
        assert_eq!(a.doc.settings.n, vec![2, 4, 8, 16]);
        for c in ":q".chars() {
            a.on_key(key(c));
        }
        press(&mut a, KeyCode::Enter);
        assert!(a.quit);

        // everything above was persisted
        let disk = store::load().unwrap();
        assert_eq!(disk.settings.n, vec![2, 4, 8, 16]);
        assert!(disk.sentences.iter().any(|s| s.text == "brand new"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn turns_order_and_daily_cap() {
        let _disk = temp_data();
        let cmd = |a: &mut App, s: &str| {
            press(a, KeyCode::Char(':'));
            for c in s.chars() {
                a.on_key(key(c));
            }
            press(a, KeyCode::Enter);
        };
        let mut a = app_with(5);
        assert_eq!(a.rows(Pane::Qa).len(), 5);
        cmd(&mut a, "set limit=2 order=oldest");
        assert!(!a.msg_err, "{}", a.msg);
        assert_eq!(a.rows(Pane::Qa).len(), 2);
        a.focus = Pane::Qa;
        a.on_key(key('c'));
        let done = a.rows(Pane::Qa)[0].id.clone();
        // a finished row stays and keeps its place under the cap
        cmd(&mut a, "set order=newest");
        let rows = a.rows(Pane::Qa);
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|r| r.id == done));
        cmd(&mut a, "set turns=6");
        assert_eq!(a.doc.settings.n, vec![1, 3, 7, 14, 28, 56]);
        cmd(&mut a, "set preset=daily n8=9");
        assert_eq!(a.doc.settings.n, vec![1, 2, 3, 4, 5, 6, 7, 9]);
        cmd(&mut a, "set turns=21");
        assert!(a.msg_err);
        assert!(screen(&mut a).contains("□8"));

        // a restart on the same day gets the very same list back
        let saved = store::TodayState {
            date: fmt_date(a.today),
            sig: a.settings_sig(),
            qa: a.panes[Pane::Qa as usize].due.clone(),
            ..Default::default()
        };
        let mut b = App::new(a.doc.clone(), a.today);
        b.apply_saved(saved.clone());
        assert_eq!(b.panes[Pane::Qa as usize].due, saved.qa);
        // next day: a fresh list
        let mut c = App::new(a.doc.clone(), a.today + chrono::Duration::days(1));
        c.apply_saved(saved);
        assert!(!c.panes[Pane::Qa as usize].due.contains(&(done.clone(), 1)));
    }

    #[test]
    fn qr_speed_is_a_rate() {
        assert_eq!(short_num(2.5), "2.5");
        assert_eq!(short_num(3.0), "3");
        let mut a = app_with(20);
        a.open_qr(60).unwrap();
        let n = match &a.mode {
            Mode::Qr(q) => q.blocks.len(),
            _ => unreachable!(),
        };
        assert!(n > 1);
        let s = screen(&mut a);
        assert!(s.contains("2.5 frames/s"), "{s}");
        a.on_key(key('+'));
        assert!(screen(&mut a).contains("3 frames/s"));
        for _ in 0..20 {
            a.on_key(key('-'));
        }
        assert!(screen(&mut a).contains("0.5 frames/s"));
        if let Mode::Qr(q) = &a.mode {
            assert_eq!(q.interval(), Duration::from_secs(2));
        }
    }

    #[test]
    fn counts_and_motions() {
        let mut a = app_with(10);
        assert_eq!(a.focus, Pane::Qa);
        a.on_key(key('3'));
        a.on_key(key('j'));
        assert_eq!(a.panes[1].sel, 3);
        a.on_key(key('G'));
        assert_eq!(a.panes[1].sel, 9);
        a.on_key(key('g'));
        a.on_key(key('g'));
        assert_eq!(a.panes[1].sel, 0);
        a.on_key(key('5'));
        a.on_key(key('G'));
        assert_eq!(a.panes[1].sel, 4);
    }

    #[test]
    fn line_input_editing() {
        let mut l = LineInput::from("hello world");
        l.edit(KeyEvent::new(KeyCode::Char('w'), KeyModifiers::CONTROL));
        assert_eq!(l.text(), "hello ");
        l.edit(key('日'));
        assert_eq!(l.text(), "hello 日");
        let (v, cx) = l.view(80);
        assert_eq!(v, "hello 日");
        assert_eq!(cx, 8);
    }
}
