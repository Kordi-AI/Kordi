//! Both engines advertise only communication tools backed by this turn's runtime.
use kordi_tools::ToolContext;
use serde_json::Value;

pub(crate) fn available_definitions(definitions: &[Value], context: &ToolContext) -> Vec<Value> {
    filter_definitions(
        definitions,
        context.reach_out.is_some(),
        context.plan_card.is_some(),
    )
}

/// Drops `reach_out` and `plan_card` when this turn has no runtime for them,
/// keeping every other tool in its order.
fn filter_definitions(definitions: &[Value], outreach: bool, plan_cards: bool) -> Vec<Value> {
    definitions
        .iter()
        .filter(
            |definition| match definition.pointer("/function/name").and_then(Value::as_str) {
                Some("reach_out") => outreach,
                Some(kordi_tools::plan_card::NAME) => plan_cards,
                _ => true,
            },
        )
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unconfigured_outreach_is_not_advertised_and_other_tools_keep_their_order() {
        let definitions = vec![
            json!({"function":{"name":"read_session"}}),
            json!({"function":{"name":"reach_out"}}),
            json!({"function":{"name":"web_search"}}),
        ];
        assert_eq!(
            filter_definitions(&definitions, false, false),
            vec![definitions[0].clone(), definitions[2].clone()]
        );
        assert_eq!(filter_definitions(&definitions, true, false), definitions);
    }

    #[test]
    fn plan_cards_are_advertised_only_with_their_runtime() {
        let definitions = vec![
            json!({"function":{"name":"reach_out"}}),
            json!({"function":{"name":"plan_card"}}),
            json!({"function":{"name":"web_search"}}),
        ];
        assert_eq!(
            filter_definitions(&definitions, true, false),
            vec![definitions[0].clone(), definitions[2].clone()]
        );
        assert_eq!(filter_definitions(&definitions, true, true), definitions);
    }
}
