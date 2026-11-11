//! The language rule for a turn's tail note. Owner memories, the persona, or
//! earlier messages in another language must not decide the reply's
//! language; the current request does, on first turns and continuations.
use serde_json::Value;

/// The text the requester wrote: a continuation's `originalRequest`, else the
/// run's prompt.
fn requester_text(prompt: &str) -> String {
    prompt
        .rsplit_once("\n{")
        .and_then(|(_, rest)| serde_json::from_str::<Value>(&format!("{{{rest}")).ok())
        .and_then(|data| data["originalRequest"].as_str().map(str::to_owned))
        .unwrap_or_else(|| prompt.to_owned())
}

/// One line naming the language the reply must use.
pub(super) fn language_line(prompt: &str) -> String {
    let text = requester_text(prompt);
    let (mut han, mut kana, mut hangul, mut latin) = (0, 0, 0, 0);
    for c in text.chars() {
        match c {
            '\u{3040}'..='\u{30ff}' => kana += 1,
            '\u{ac00}'..='\u{d7af}' | '\u{1100}'..='\u{11ff}' => hangul += 1,
            '\u{4e00}'..='\u{9fff}' | '\u{3400}'..='\u{4dbf}' => han += 1,
            c if c.is_alphabetic() && c.is_ascii() => latin += 1,
            _ => {}
        }
    }
    const RULE: &str = "Write every message and the final result in the language of the current request (for a continuation, its originalRequest), even when your owner's memories, the persona, earlier messages, or other participants use another language.";
    let named = if kana > 0 {
        Some("Japanese")
    } else if hangul > 0 {
        Some("Korean")
    } else if han > 0 {
        Some("Chinese")
    } else {
        None
    };
    match named {
        Some(language) => format!("{RULE} The current request is in {language}."),
        None if latin > 0 => format!("{RULE} The current request is not in Chinese, Japanese, or Korean, so do not answer in those languages."),
        None => RULE.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::language_line;

    #[test]
    fn the_request_language_wins_over_history() {
        let english = language_line("@KordiAlex find a time for a 1-hour call on Saturday");
        assert!(english.contains("not in Chinese"), "{english}");
        assert!(language_line("\u{5e2e}\u{6211}\u{7ea6}\u{5468}\u{516d}\u{4e00}\u{5c0f}\u{65f6}\u{7684}\u{7535}\u{8bdd}").ends_with("is in Chinese."));
        let continuation = format!(
            "Continue only the originalRequest below.\n{}",
            serde_json::json!({"originalRequest":"Find a time on Saturday","personReply":"\u{5468}\u{516d}\u{4e0b}\u{5348}\u{4e09}\u{70b9}\u{53ef}\u{4ee5}"})
        );
        assert!(language_line(&continuation).contains("not in Chinese"));
        let chinese = format!(
            "Continue only the originalRequest below.\n{}",
            serde_json::json!({"originalRequest":"\u{627e}\u{4e2a}\u{5468}\u{516d}\u{7684}\u{65f6}\u{95f4}","agentReply":"Saturday 3pm works"})
        );
        assert!(language_line(&chinese).ends_with("is in Chinese."));
    }
}
