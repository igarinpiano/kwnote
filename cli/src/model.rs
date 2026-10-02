//! Data model shared with the web app (same JSON shape as the browser's
//! localStorage / EXPORT format) and the merge rules used by every sync path.
//!
//! Merge rule (must stay identical to `mergeDocs` in ../../sync.js):
//! * records are matched by `id`
//! * the copy with the larger `updatedAt` wins
//! * on a tie with differing content, `completedTurns` are unioned and
//!   `deleted` is OR-ed (this covers legacy data that has no `updatedAt`)
//! * deletions are tombstones (`deleted: true`) so they propagate

use std::collections::{HashMap, HashSet};

use chrono::{Duration, Local, NaiveDate};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

pub const DEFAULT_INTERVALS: [i64; 4] = [1, 3, 7, 14];
/// Most turns (表示回数) the settings UIs accept. Stored data may hold more
/// (anything up to 255 is kept), it is only an input limit.
pub const MAX_TURNS: usize = 20;

/// Interval presets offered by the web app, `kwnote settings --preset` and
/// `:set preset=` (same list as PRESETS in ../../script.js).
pub const PRESETS: &[(&str, &str, &[i64])] = &[
    ("standard", "標準", &[1, 3, 7, 14]),
    ("dense", "こまめ", &[1, 2, 3, 5, 7, 10, 14]),
    ("long", "長期", &[1, 3, 7, 14, 30, 60, 120]),
    ("daily", "毎日", &[1, 2, 3, 4, 5, 6, 7]),
];

pub fn preset(name: &str) -> Option<&'static [i64]> {
    PRESETS
        .iter()
        .find(|(k, ja, _)| k.eq_ignore_ascii_case(name.trim()) || *ja == name.trim())
        .map(|(_, _, n)| *n)
}

/// Order of today's list (`settings.order`, same values as script.js).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Order {
    /// shuffled (the original behaviour)
    #[default]
    Random,
    /// most overdue first (earliest scheduled date)
    Due,
    /// registered earliest first
    Oldest,
    /// registered latest first
    Newest,
}

impl Order {
    pub const ALL: [Order; 4] = [Order::Random, Order::Due, Order::Oldest, Order::Newest];

    pub fn as_str(self) -> &'static str {
        match self {
            Order::Random => "random",
            Order::Due => "due",
            Order::Oldest => "oldest",
            Order::Newest => "newest",
        }
    }

    pub fn parse(s: &str) -> Option<Order> {
        Order::ALL.into_iter().find(|o| o.as_str() == s.trim())
    }
}

fn null_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

/// Accepts integers, floats, numeric strings and null (hand-edited JSON).
fn lenient_i64<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Number(n) => n
            .as_i64()
            .unwrap_or_else(|| n.as_f64().unwrap_or(0.0) as i64),
        Value::String(s) => s.trim().parse().unwrap_or(0),
        _ => 0,
    })
}

fn lenient_turns<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
    let v = Option::<Vec<Value>>::deserialize(d)?.unwrap_or_default();
    let mut out: Vec<u8> = v
        .iter()
        .filter_map(|x| x.as_u64().or_else(|| x.as_f64().map(|f| f as u64)))
        .filter(|t| (1..=u8::MAX as u64).contains(t))
        .map(|t| t as u8)
        .collect();
    out.sort_unstable();
    out.dedup();
    Ok(out)
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    #[serde(default, deserialize_with = "null_default")]
    pub question: String,
    #[serde(default, deserialize_with = "null_default")]
    pub answer: String,
    #[serde(default, deserialize_with = "null_default")]
    pub note: String,
    #[serde(default, deserialize_with = "null_default")]
    pub registered_date: String,
    #[serde(default, deserialize_with = "lenient_turns")]
    pub completed_turns: Vec<u8>,
    #[serde(default, deserialize_with = "lenient_i64")]
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "is_false")]
    pub deleted: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sentence {
    pub id: String,
    #[serde(default, deserialize_with = "null_default")]
    pub text: String,
    #[serde(default, deserialize_with = "null_default")]
    pub registered_date: String,
    #[serde(default, deserialize_with = "lenient_turns")]
    pub completed_turns: Vec<u8>,
    #[serde(default, deserialize_with = "lenient_i64")]
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "is_false")]
    pub deleted: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_intervals", deserialize_with = "lenient_intervals")]
    pub n: Vec<i64>,
    #[serde(default, deserialize_with = "lenient_i64")]
    pub updated_at: i64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn default_intervals() -> Vec<i64> {
    DEFAULT_INTERVALS.to_vec()
}

/// Any length (one entry per turn); bad values become 0, and a missing or
/// empty list means the defaults (like `normSettings` in script.js).
fn lenient_intervals<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<i64>, D::Error> {
    let v = Option::<Vec<Value>>::deserialize(d)?.unwrap_or_default();
    let n: Vec<i64> = v
        .iter()
        .map(|x| match x {
            Value::Number(n) => n
                .as_i64()
                .unwrap_or_else(|| n.as_f64().unwrap_or(0.0) as i64),
            Value::String(s) => s.trim().parse().unwrap_or(0),
            _ => 0,
        })
        .map(|x| x.max(0))
        .collect();
    Ok(if n.is_empty() { default_intervals() } else { n })
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            n: default_intervals(),
            updated_at: 0,
            extra: Map::new(),
        }
    }
}

// `order` and `limit` live in `extra` so that the JSON round-trips exactly
// as the web app wrote it (absent stays absent).
impl Settings {
    pub fn interval(&self, turn: u8) -> i64 {
        self.n.get(turn as usize - 1).copied().unwrap_or(0)
    }

    /// Number of turns (表示回数) = number of intervals.
    pub fn turns(&self) -> u8 {
        self.n.len().min(u8::MAX as usize) as u8
    }

    pub fn order(&self) -> Order {
        self.extra
            .get("order")
            .and_then(Value::as_str)
            .and_then(Order::parse)
            .unwrap_or_default()
    }

    pub fn set_order(&mut self, o: Order) {
        self.extra.insert("order".into(), Value::from(o.as_str()));
    }

    /// Daily cap per pane for today's list; 0 = no cap.
    pub fn limit(&self) -> usize {
        match self.extra.get("limit") {
            Some(Value::Number(n)) => n.as_u64().or_else(|| n.as_f64().map(|f| f.max(0.0) as u64)),
            Some(Value::String(s)) => s.trim().parse().ok(),
            _ => None,
        }
        .unwrap_or(0) as usize
    }

    pub fn set_limit(&mut self, n: usize) {
        self.extra.insert("limit".into(), Value::from(n));
    }

    /// One-line summary used by `kwnote settings`, `stats` and `:set`.
    pub fn describe(&self) -> String {
        let limit = match self.limit() {
            0 => "none".to_string(),
            n => n.to_string(),
        };
        format!(
            "n={} ({} turns) order={} limit={limit}",
            self.n
                .iter()
                .map(i64::to_string)
                .collect::<Vec<_>>()
                .join(","),
            self.n.len(),
            self.order().as_str()
        )
    }
}

/// Validate user-entered intervals (settings UIs).
pub fn check_intervals(n: &[i64]) -> Result<(), String> {
    if n.is_empty() || n.len() > MAX_TURNS {
        return Err(format!("give 1 to {MAX_TURNS} intervals"));
    }
    if n.iter().any(|x| *x < 0) {
        return Err("intervals must be >= 0".into());
    }
    Ok(())
}

fn default_version() -> u32 {
    2
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Doc {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default, deserialize_with = "null_default")]
    pub items: Vec<Item>,
    #[serde(default, deserialize_with = "null_default")]
    pub sentences: Vec<Sentence>,
    #[serde(default, deserialize_with = "null_default")]
    pub settings: Settings,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Doc {
    fn default() -> Self {
        Doc {
            version: 2,
            items: vec![],
            sentences: vec![],
            settings: Settings::default(),
            extra: Map::new(),
        }
    }
}

/// What the merge and scheduling code needs from a record.
pub trait Record: Clone + PartialEq {
    fn id(&self) -> &str;
    fn updated_at(&self) -> i64;
    fn deleted(&self) -> bool;
    fn set_deleted(&mut self, v: bool);
    fn registered_date(&self) -> &str;
    fn completed_turns(&self) -> &[u8];
    fn completed_turns_mut(&mut self) -> &mut Vec<u8>;
    fn touch(&mut self);
    /// Concatenated user-visible text, used by search.
    fn haystack(&self) -> String;
}

macro_rules! impl_record {
    ($t:ty, |$s:ident| $hay:expr) => {
        impl Record for $t {
            fn id(&self) -> &str {
                &self.id
            }
            fn updated_at(&self) -> i64 {
                self.updated_at
            }
            fn deleted(&self) -> bool {
                self.deleted
            }
            fn set_deleted(&mut self, v: bool) {
                self.deleted = v;
            }
            fn registered_date(&self) -> &str {
                &self.registered_date
            }
            fn completed_turns(&self) -> &[u8] {
                &self.completed_turns
            }
            fn completed_turns_mut(&mut self) -> &mut Vec<u8> {
                &mut self.completed_turns
            }
            fn touch(&mut self) {
                self.updated_at = next_stamp(self.updated_at);
            }
            fn haystack(&self) -> String {
                let $s = self;
                $hay
            }
        }
    };
}

impl_record!(Item, |s| format!(
    "{}\n{}\n{}",
    s.question, s.answer, s.note
));
impl_record!(Sentence, |s| s.text.clone());

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A timestamp strictly newer than `prev`. Two edits within the same
/// millisecond would otherwise tie, and a tie merges (ORs `deleted`) instead
/// of letting the later edit win.
pub fn next_stamp(prev: i64) -> i64 {
    now_ms().max(prev + 1)
}

pub fn today() -> NaiveDate {
    Local::now().date_naive()
}

pub fn fmt_date(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

pub fn parse_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").ok()
}

/// `today`, `+N`, `-N`, or `YYYY-MM-DD`.
pub fn parse_date_arg(s: &str, base: NaiveDate) -> Option<NaiveDate> {
    let s = s.trim();
    if s.is_empty() || s == "today" {
        return Some(today());
    }
    if let Some(rest) = s.strip_prefix('+') {
        return rest.parse::<i64>().ok().map(|n| base + Duration::days(n));
    }
    if s.starts_with('-') && s.len() < 6 {
        return s.parse::<i64>().ok().map(|n| base + Duration::days(n));
    }
    parse_date(s)
}

pub fn new_id(prefix: &str) -> String {
    let mut buf = [0u8; 4];
    let _ = getrandom::fill(&mut buf);
    let rnd: String = buf.iter().map(|b| format!("{b:02x}")).collect();
    format!("{prefix}{}_{rnd}", now_ms())
}

fn sched_date<R: Record>(r: &R, settings: &Settings, turn: u8) -> NaiveDate {
    let reg = parse_date(r.registered_date()).unwrap_or_else(today);
    reg + Duration::days(settings.interval(turn))
}

/// Port of `dueTurn` in script.js: the first unfinished turn, if its scheduled
/// date (registeredDate + n[turn-1]) is on or before `today`.
pub fn due_turn<R: Record>(r: &R, settings: &Settings, today: NaiveDate) -> Option<u8> {
    if r.deleted() {
        return None;
    }
    let (turn, date) = next_turn(r, settings)?;
    (date <= today).then_some(turn)
}

/// The first unfinished turn and when it is scheduled. `None` = all done.
pub fn next_turn<R: Record>(r: &R, settings: &Settings) -> Option<(u8, NaiveDate)> {
    (1..=settings.turns())
        .find(|t| !r.completed_turns().contains(t))
        .map(|t| (t, sched_date(r, settings, t)))
}

/// Tiny xorshift so we don't need the `rand` crate just to shuffle.
pub fn shuffle<T>(v: &mut [T]) {
    let mut seed = [0u8; 8];
    let _ = getrandom::fill(&mut seed);
    let mut x = u64::from_le_bytes(seed) | 1;
    for i in (1..v.len()).rev() {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        v.swap(i, (x % (i as u64 + 1)) as usize);
    }
}

/// Today's list for one pane (port of `buildToday` in script.js).
///
/// `carry` comes first, in its order (entries of deleted records dropped);
/// then the due records that aren't carried, sorted by `settings.order()`,
/// only as many as still fit under `settings.limit()` (0 = no cap). Done
/// entries stay in the list for the rest of the day, so they count toward
/// the cap.
pub fn build_today<R: Record>(
    recs: &[R],
    settings: &Settings,
    today: NaiveDate,
    carry: &[(String, u8)],
) -> Vec<(String, u8)> {
    let alive: HashSet<&str> = recs
        .iter()
        .filter(|r| !r.deleted())
        .map(|r| r.id())
        .collect();
    let mut have: HashSet<&str> = HashSet::new();
    let mut out: Vec<(String, u8)> = carry
        .iter()
        .filter(|(id, _)| alive.contains(id.as_str()) && have.insert(id.as_str()))
        .cloned()
        .collect();
    let mut cand: Vec<(&R, u8, NaiveDate)> = recs
        .iter()
        .filter(|r| !have.contains(r.id()))
        .filter_map(|r| {
            let t = due_turn(r, settings, today)?;
            Some((r, t, sched_date(r, settings, t)))
        })
        .collect();
    match settings.order() {
        Order::Random => shuffle(&mut cand),
        Order::Due => cand.sort_by(|a, b| {
            a.2.cmp(&b.2)
                .then_with(|| a.0.registered_date().cmp(b.0.registered_date()))
        }),
        Order::Oldest => cand.sort_by(|a, b| a.0.registered_date().cmp(b.0.registered_date())),
        Order::Newest => cand.sort_by(|a, b| b.0.registered_date().cmp(a.0.registered_date())),
    }
    let room = match settings.limit() {
        0 => usize::MAX,
        n => n.saturating_sub(out.len()),
    };
    out.extend(
        cand.into_iter()
            .take(room)
            .map(|(r, t, _)| (r.id().to_string(), t)),
    );
    out
}

/// Toggle completion of `turn`. Returns true if it is now completed.
pub fn toggle_turn<R: Record>(r: &mut R, turn: u8) -> bool {
    let turns = r.completed_turns_mut();
    let done = if let Some(pos) = turns.iter().position(|&t| t == turn) {
        turns.remove(pos);
        false
    } else {
        turns.push(turn);
        turns.sort_unstable();
        true
    };
    r.touch();
    done
}

fn pick<R: Record>(local: &R, other: &R) -> R {
    use std::cmp::Ordering::*;
    match other.updated_at().cmp(&local.updated_at()) {
        Greater => other.clone(),
        Less => local.clone(),
        Equal if local == other => local.clone(),
        Equal => {
            let mut r = local.clone();
            let mut turns: Vec<u8> = local.completed_turns().to_vec();
            turns.extend_from_slice(other.completed_turns());
            turns.sort_unstable();
            turns.dedup();
            *r.completed_turns_mut() = turns;
            r.set_deleted(local.deleted() || other.deleted());
            r
        }
    }
}

pub fn merge_records<R: Record>(local: &[R], other: &[R]) -> Vec<R> {
    let mut out: Vec<R> = Vec::with_capacity(local.len() + other.len());
    let mut index: HashMap<String, usize> = HashMap::new();
    for r in local.iter().chain(other.iter()) {
        match index.get(r.id()) {
            Some(&i) => out[i] = pick(&out[i], r),
            None => {
                index.insert(r.id().to_string(), out.len());
                out.push(r.clone());
            }
        }
    }
    out
}

pub fn merge_docs(local: &Doc, other: &Doc) -> Doc {
    let settings = if other.settings.updated_at > local.settings.updated_at {
        other.settings.clone()
    } else {
        local.settings.clone()
    };
    let mut extra = other.extra.clone();
    extra.extend(local.extra.clone());
    Doc {
        version: local.version.max(other.version).max(2),
        items: merge_records(&local.items, &other.items),
        sentences: merge_records(&local.sentences, &other.sentences),
        settings,
        extra,
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    pub items: usize,
    pub sentences: usize,
    pub due_items: usize,
    pub due_sentences: usize,
    pub finished: usize,
    pub due_tomorrow: usize,
}

pub fn stats(doc: &Doc, today: NaiveDate) -> Stats {
    let mut s = Stats::default();
    let tomorrow = today + Duration::days(1);
    let mut visit = |r: &dyn Fn(NaiveDate) -> Option<u8>, done: bool, is_item: bool| {
        if is_item {
            s.items += 1;
        } else {
            s.sentences += 1;
        }
        if done {
            s.finished += 1;
        }
        if r(today).is_some() {
            if is_item {
                s.due_items += 1;
            } else {
                s.due_sentences += 1;
            }
        } else if r(tomorrow).is_some() {
            s.due_tomorrow += 1;
        }
    };
    for it in doc.items.iter().filter(|x| !x.deleted) {
        visit(
            &|d| due_turn(it, &doc.settings, d),
            next_turn(it, &doc.settings).is_none(),
            true,
        );
    }
    for se in doc.sentences.iter().filter(|x| !x.deleted) {
        visit(
            &|d| due_turn(se, &doc.settings, d),
            next_turn(se, &doc.settings).is_none(),
            false,
        );
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, at: i64, turns: &[u8]) -> Item {
        Item {
            id: id.into(),
            question: format!("q-{id}"),
            answer: "a".into(),
            registered_date: "2026-01-01".into(),
            completed_turns: turns.to_vec(),
            updated_at: at,
            ..Default::default()
        }
    }

    #[test]
    fn newer_wins_and_union_on_legacy_tie() {
        let a = Doc {
            items: vec![item("x", 5, &[1]), item("y", 0, &[1])],
            ..Default::default()
        };
        let b = Doc {
            items: vec![item("x", 9, &[]), item("y", 0, &[2]), item("z", 1, &[])],
            ..Default::default()
        };
        let m = merge_docs(&a, &b);
        assert_eq!(m.items.len(), 3);
        assert_eq!(m.items[0].completed_turns, Vec::<u8>::new());
        assert_eq!(m.items[1].completed_turns, vec![1, 2]);
        assert_eq!(m.items[2].id, "z");
        // commutative in content (order may differ)
        let m2 = merge_docs(&b, &a);
        for it in &m.items {
            let other = m2.items.iter().find(|o| o.id == it.id).unwrap();
            assert_eq!(it.completed_turns, other.completed_turns);
        }
    }

    #[test]
    fn tombstones_propagate() {
        let mut dead = item("x", 10, &[]);
        dead.deleted = true;
        let a = Doc {
            items: vec![item("x", 5, &[])],
            ..Default::default()
        };
        let b = Doc {
            items: vec![dead],
            ..Default::default()
        };
        assert!(merge_docs(&a, &b).items[0].deleted);
    }

    #[test]
    fn due_matches_web_semantics() {
        let s = Settings::default();
        let d = |x: &str| parse_date(x).unwrap();
        let it = item("x", 0, &[]);
        assert_eq!(due_turn(&it, &s, d("2026-01-01")), None);
        assert_eq!(due_turn(&it, &s, d("2026-01-02")), Some(1));
        let it = item("x", 0, &[1]);
        assert_eq!(due_turn(&it, &s, d("2026-01-03")), None);
        assert_eq!(due_turn(&it, &s, d("2026-01-04")), Some(2));
        let it = item("x", 0, &[1, 2, 3, 4]);
        assert_eq!(due_turn(&it, &s, d("2027-01-01")), None);
    }

    #[test]
    fn more_turns_and_settings_round_trip() {
        let raw = r#"{"n":[1,2,"4",7,-3,30],"order":"due","limit":"2","updatedAt":5}"#;
        let s: Settings = serde_json::from_str(raw).unwrap();
        assert_eq!(s.n, vec![1, 2, 4, 7, 0, 30]);
        assert_eq!(s.turns(), 6);
        assert_eq!(s.order(), Order::Due);
        assert_eq!(s.limit(), 2);
        let empty: Settings = serde_json::from_str(r#"{"n":[]}"#).unwrap();
        assert_eq!(empty.n, DEFAULT_INTERVALS.to_vec());
        assert_eq!(empty.order(), Order::Random);
        assert_eq!(empty.limit(), 0);
        // untouched keys are not added when written back
        let back = serde_json::to_value(&empty).unwrap();
        assert!(back.get("order").is_none() && back.get("limit").is_none());

        let d = |x: &str| parse_date(x).unwrap();
        // turn 5 has interval 0 (the -3 above), so it is due at once
        let it = item("x", 0, &[1, 2, 3, 4]);
        assert_eq!(due_turn(&it, &s, d("2026-01-01")), Some(5));
        let it = item("x", 0, &[1, 2, 3, 4, 5]);
        assert_eq!(due_turn(&it, &s, d("2026-01-30")), None);
        assert_eq!(due_turn(&it, &s, d("2026-01-31")), Some(6));
        let it = item("x", 0, &[1, 2, 3, 4, 5, 6]);
        assert_eq!(next_turn(&it, &s), None);
        // turns above 4 survive parsing
        let raw = r#"{"id":"a","completedTurns":[12,5,1]}"#;
        let it: Item = serde_json::from_str(raw).unwrap();
        assert_eq!(it.completed_turns, vec![1, 5, 12]);
        assert_eq!(preset("long").unwrap().len(), 7);
        assert_eq!(preset("毎日"), preset("daily"));
        assert!(check_intervals(&[1; 21]).is_err() && check_intervals(&[]).is_err());
    }

    #[test]
    fn todays_list_order_limit_and_carry() {
        let mut s = Settings::default();
        let d = parse_date("2026-02-01").unwrap();
        let mut recs = vec![];
        for (i, reg) in ["2026-01-05", "2026-01-01", "2026-01-03"]
            .iter()
            .enumerate()
        {
            let mut it = item(&format!("r{i}"), 0, &[]);
            it.registered_date = reg.to_string();
            recs.push(it);
        }
        let ids = |v: &[(String, u8)]| v.iter().map(|x| x.0.clone()).collect::<Vec<_>>();
        s.set_order(Order::Oldest);
        assert_eq!(ids(&build_today(&recs, &s, d, &[])), ["r1", "r2", "r0"]);
        s.set_order(Order::Newest);
        assert_eq!(ids(&build_today(&recs, &s, d, &[])), ["r0", "r2", "r1"]);
        s.set_order(Order::Due);
        assert_eq!(ids(&build_today(&recs, &s, d, &[])), ["r1", "r2", "r0"]);
        s.set_limit(2);
        let today = build_today(&recs, &s, d, &[]);
        assert_eq!(ids(&today), ["r1", "r2"]);
        // a done entry stays and keeps counting toward the cap
        let carry = vec![("r0".to_string(), 1)];
        assert_eq!(ids(&build_today(&recs, &s, d, &carry)), ["r0", "r1"]);
        // reconcile with a full list adds nothing
        assert_eq!(build_today(&recs, &s, d, &today), today);
        recs[1].deleted = true;
        assert_eq!(ids(&build_today(&recs, &s, d, &today)), ["r2", "r0"]);
        s.set_limit(0);
        s.set_order(Order::Random);
        assert_eq!(build_today(&recs, &s, d, &[]).len(), 2);
    }

    #[test]
    fn parses_legacy_web_export() {
        let raw = r#"{"items":[{"id":"id_1","question":"Q","answer":"A","note":null,
            "registeredDate":"2026-09-01","completedTurns":[1,"x",2],"custom":true}],
            "settings":{"n":[1,2,3,4]},
            "sentences":[{"id":"s_1","text":"hello","registeredDate":"2026-09-01"}]}"#;
        let doc: Doc = serde_json::from_str(raw).unwrap();
        assert_eq!(doc.items[0].completed_turns, vec![1, 2]);
        assert_eq!(doc.items[0].updated_at, 0);
        assert_eq!(doc.items[0].extra.get("custom"), Some(&Value::Bool(true)));
        assert_eq!(doc.settings.n, vec![1, 2, 3, 4]);
        assert!(doc.sentences[0].completed_turns.is_empty());
        let back = serde_json::to_value(&doc).unwrap();
        assert_eq!(back["items"][0]["custom"], Value::Bool(true));
    }
}
