//! Data model shared with the web app (same JSON shape as the browser's
//! localStorage / EXPORT format) and the merge rules used by every sync path.
//!
//! Merge rule (must stay identical to `mergeDocs` in ../../sync.js):
//! * records are matched by `id`
//! * the copy with the larger `updatedAt` wins
//! * on a tie with differing content, `completedTurns` are unioned and
//!   `deleted` is OR-ed (this covers legacy data that has no `updatedAt`)
//! * deletions are tombstones (`deleted: true`) so they propagate

use std::collections::HashMap;

use chrono::{Duration, Local, NaiveDate};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

pub const TURNS: u8 = 4;
pub const DEFAULT_INTERVALS: [i64; 4] = [1, 3, 7, 14];

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
        .filter(|t| (1..=TURNS as u64).contains(t))
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
    #[serde(default = "default_intervals")]
    pub n: Vec<i64>,
    #[serde(default, deserialize_with = "lenient_i64")]
    pub updated_at: i64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn default_intervals() -> Vec<i64> {
    DEFAULT_INTERVALS.to_vec()
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

impl Settings {
    pub fn interval(&self, turn: u8) -> i64 {
        self.n.get(turn as usize - 1).copied().unwrap_or(0)
    }
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
    (1..=TURNS)
        .find(|t| !r.completed_turns().contains(t))
        .map(|t| (t, sched_date(r, settings, t)))
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
