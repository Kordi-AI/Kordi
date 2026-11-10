//! A shared run reads its conversation with `read_session mode=info`, gets a
//! short runtime note at the tail of its context, and keeps a system prompt
//! that is the same from run to run.
use super::*;

/// The data of a turn identity's runtime note.
fn note_of(identity: &Value) -> Value {
    let text = identity["conversationContext"].as_str().expect("note");
    let line = text.lines().next().unwrap();
    assert!(
        line.starts_with("Runtime note") && line.contains("untrusted"),
        "{text}"
    );
    serde_json::from_str(&line[line.find('{').unwrap()..]).unwrap()
}

impl Fixture {
    async fn info(&self, run: &str, claim: uuid::Uuid) -> Value {
        let body = json!({"claimId":claim,"tool":"read_session","arguments":{"sessionId":self.session,"mode":"info"}});
        let value = self
            .post(
                0,
                &format!("/v1/cloud/agent-runs/desktop/{run}/context"),
                body,
            )
            .await;
        assert!(value["directory"].as_str().unwrap().contains("untrusted"));
        value["info"].clone()
    }
    /// A group request from `sender` to Alpha's agent, as a client sends it.
    pub(super) async fn group_request(&self, sender: usize, text: &str) -> String {
        let logical = uuid::Uuid::new_v4().to_string();
        let owner = &self.people[0].account_id;
        let participants: Vec<Value> = self
            .people
            .iter()
            .map(|p| json!({"accountId":p.account_id,"displayName":"Synthetic participant"}))
            .collect();
        let envelope = json!({"kind":"group-message","groupId":self.session,"createdByAccountId":owner,"actor":{"accountId":owner,"displayName":"Synthetic owner"},"participants":participants,
            "message":{"id":logical,"senderAccountId":self.people[sender].account_id,"senderKind":"human","text":text,"createdAtMs":chrono::Utc::now().timestamp_millis(),"targetCloudAgentId":format!("cloud-agent:{owner}"),"targetCloudAgentOwnerAccountId":owner,"targetCloudAgentName":"Kordi"}});
        let body = format!(
            "kordi-cloud-group:{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(envelope.to_string())
        );
        insert_test_message(
            &self.pool,
            &self.people[sender].account_id,
            self.conversation().await,
            &body,
        )
        .await;
        logical
    }
}

#[tokio::test]
async fn a_shared_run_reads_conversation_info_and_gets_a_tail_note() {
    let Some(f) = Fixture::requested_by(true, 1).await else {
        return;
    };
    let note = note_of(&f.identity);
    let people = note["members"]["people"].as_array().unwrap();
    assert_eq!(people.len(), 3, "{note}");
    assert!(people.iter().any(|p| p["isOwner"] == true));
    assert!(people
        .iter()
        .any(|p| p["isRequester"] == true && p["handle"] == "@ExchangeBeta"));
    assert_eq!(note["nowTimeZone"], "UTC");
    let reach = f.identity["conversationContext"].as_str().unwrap();
    assert!(reach.contains("You can reach_out to:") && reach.contains(&f.people[1].account_id));

    let receipt = f.ask_ok("ask", 1, "Which area?").await;
    let info = f.info(&f.root, f.claim).await;
    assert_eq!(info["conversation"]["kind"], "group");
    assert_eq!(info["people"].as_array().unwrap().len(), 3);
    assert!(info["agents"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["isYou"] == true));
    let open = info["openQuestions"].as_array().unwrap();
    assert_eq!(open.len(), 1, "{info}");
    assert_eq!(open[0]["to"], "Exchange Beta");
    assert_eq!(open[0]["status"], "pending");
    assert_eq!(info["planCards"], json!([]));
    assert!(info["people"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p.get("location").is_none()));

    // Profile fields set later and a member who left reach the next run.
    query("UPDATE cloud_accounts SET location='Synthetic City', time_zone='Asia/Shanghai' WHERE account_id=$1")
        .bind(&f.people[1].account_id).execute(&f.pool).await.unwrap();
    query("UPDATE cloud_accounts SET time_zone='America/Los_Angeles' WHERE account_id=$1")
        .bind(&f.people[0].account_id)
        .execute(&f.pool)
        .await
        .unwrap();
    query("UPDATE cloud_chat_conversation_members SET membership_state='left' WHERE account_id=$1")
        .bind(&f.people[2].account_id)
        .execute(&f.pool)
        .await
        .unwrap();
    f.end_parent().await;
    f.say(1, "Downtown", None).await;
    assert_eq!(f.exchange(&receipt["exchangeId"]).await.0, "reply_received");
    let resume = f.pending(0).await.remove(0);
    let body = json!({"claimId":uuid::Uuid::new_v4(),"requestMessageId":resume["requestMessageId"],"sessionId":f.session,"ownerAccountId":f.people[0].account_id,"requesterAccountId":resume["requesterAccountId"],"prompt":resume["prompt"],"idempotencyKey":resume["runId"]});
    let claim: uuid::Uuid = body["claimId"].as_str().unwrap().parse().unwrap();
    let claimed = f.post(0, "/v1/cloud/agent-runs/desktop/claim", body).await;
    let note = note_of(&claimed["turnIdentity"]);
    assert_eq!(
        note["members"]["people"].as_array().unwrap().len(),
        2,
        "members changed: {note}"
    );
    assert_eq!(note["nowTimeZone"], "America/Los_Angeles");
    let info = f.info(resume["runId"].as_str().unwrap(), claim).await;
    let beta = info["people"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["participantId"] == f.people[1].account_id.as_str())
        .unwrap();
    assert_eq!(beta["location"], "Synthetic City");
    assert_eq!(beta["timeZone"], "Asia/Shanghai");
    assert!(
        !info.to_string().contains(&f.people[2].account_id),
        "only active members"
    );
}

#[tokio::test]
async fn an_owners_own_request_in_a_direct_chat_carries_its_identity_from_admission() {
    let Some(f) = Fixture::kind(false).await else {
        return;
    };
    let owner = f.people[0].account_id.clone();
    let agent = format!("cloud-agent:{owner}");
    let wire = f
        .say(
            0,
            &agent_request("plan Friday hiking for us", &agent, &owner),
            None,
        )
        .await
        .to_string();
    let body = json!({"requestMessageId":wire,"sessionId":f.session,"ownerAccountId":owner,"requesterAccountId":owner,"prompt":"plan Friday hiking for us","idempotencyKey":format!("shared:{wire}:{owner}")});
    // The requester's client admits the run, held for the owner's Mac.
    let admitted = f.post(0, "/v1/cloud/agent-runs/claim", body.clone()).await;
    let run = admitted["runId"].as_str().unwrap().to_owned();
    let (trigger, stored): (String, Option<Value>) =
        query_as("SELECT run_trigger,turn_identity FROM cloud_agent_fallback_runs WHERE run_id=$1")
            .bind(&run)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(trigger, "person_started");
    let stored = stored.expect("a chat run carries its identity from admission");
    let note = note_of(&stored);
    assert_eq!(
        note["membersUnchanged"], true,
        "the agent saw these members in its last run here: {note}"
    );
    assert!(stored["conversationContext"]
        .as_str()
        .unwrap()
        .contains("You can reach_out to:"));

    // The owner's Mac takes the same run and receives the same identity.
    let mut claim = body;
    claim["claimId"] = json!(uuid::Uuid::new_v4());
    let claimed = f.post(0, "/v1/cloud/agent-runs/desktop/claim", claim).await;
    assert_eq!(claimed["acquired"], true, "{claimed}");
    assert_eq!(claimed["runId"], run.as_str());
    assert_eq!(claimed["turnIdentity"], stored);
}

#[tokio::test]
async fn runs_in_one_conversation_share_a_byte_identical_system_prompt() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    // Alpha's Mac is offline, so both requests go to the cloud runner.
    query("UPDATE cloud_agent_desktop_capabilities SET updated_at=now()-interval '1 hour' WHERE agent_id=$1")
        .bind(format!("cloud-agent:{}", f.people[0].account_id)).execute(&f.pool).await.unwrap();
    query("UPDATE cloud_device_presence SET last_heartbeat_at=(now()-interval '1 hour')::text WHERE account_id=$1")
        .bind(&f.people[0].account_id).execute(&f.pool).await.unwrap();
    let mut leased = Vec::new();
    for (sender, text) in [(0, "Plan Friday dinner"), (1, "Plan Saturday lunch")] {
        if sender == 1 {
            // Members, the time, and the task budget all differ for the second run.
            f.ask_ok("budget", 2, "Joining?").await;
            query("UPDATE cloud_chat_conversation_members SET membership_state='left' WHERE account_id=$1")
                .bind(&f.people[2].account_id).execute(&f.pool).await.unwrap();
        }
        let request = f.group_request(sender, text).await;
        let owner = &f.people[0].account_id;
        let body = json!({"requestMessageId":request,"sessionId":f.session,"ownerAccountId":owner,"requesterAccountId":f.people[sender].account_id,"prompt":text,"idempotencyKey":format!("prefix:{request}")});
        let run = f.post(sender, "/v1/cloud/agent-runs/claim", body).await["runId"]
            .as_str()
            .unwrap()
            .to_owned();
        let lease = f
            .router
            .clone()
            .oneshot(post_json_with_runner_token(
                "/v1/cloud/agent-runs/lease",
                "runner-test-token",
                json!({"runnerId":"prefix-runner","canaryRunId":run}),
            ))
            .await
            .unwrap();
        let lease = read_json(lease).await;
        assert_eq!(lease["run"]["runId"], run.as_str(), "{lease}");
        leased.push(lease["run"].clone());
    }
    let (first, second) = (&leased[0], &leased[1]);
    assert_eq!(
        first["systemPrompt"], second["systemPrompt"],
        "the prefix never changes per run"
    );
    let system = first["systemPrompt"].as_str().unwrap();
    assert!(
        system.contains("reach_out") && system.contains("mode=info"),
        "{system}"
    );
    for volatile in [
        "Runtime note",
        &f.people[1].account_id,
        "UTC",
        "remainingRequests",
    ] {
        assert!(
            !system.contains(volatile),
            "{volatile} must stay out of the prefix"
        );
    }
    assert_ne!(first["turnIdentity"], second["turnIdentity"]);
    assert!(
        note_of(&second["turnIdentity"])["members"].is_object(),
        "a member left"
    );
}

#[tokio::test]
async fn people_and_agents_with_the_same_name_are_told_apart_by_id() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let (beta, gamma) = (&f.people[1].account_id, &f.people[2].account_id);
    query("UPDATE cloud_accounts SET display_name=CASE WHEN account_id=$1 THEN 'Shu Yang' ELSE 'shu yang' END WHERE account_id IN ($1,$2)")
        .bind(beta).bind(gamma).execute(&f.pool).await.unwrap();
    let unique = |values: Vec<&str>| {
        let lower: std::collections::BTreeSet<String> =
            values.iter().map(|v| v.to_lowercase()).collect();
        lower.len() == values.len()
    };
    let capabilities = f.capabilities().await;
    let agents = capabilities["targets"].as_array().unwrap();
    assert_eq!(agents.len(), 2, "{capabilities}");
    assert!(
        unique(
            agents
                .iter()
                .map(|a| a["handle"].as_str().unwrap())
                .collect()
        ),
        "{capabilities}"
    );
    assert!(agents
        .iter()
        .all(|a| a["agentId"].as_str().is_some() && a["ownerAccountId"].as_str().is_some()));
    let people = capabilities["people"].as_array().unwrap();
    assert!(
        unique(
            people
                .iter()
                .map(|p| p["handle"].as_str().unwrap())
                .collect()
        ),
        "{capabilities}"
    );

    let info = f.info(&f.root, f.claim).await;
    assert_eq!(info["ownerAccountId"], f.people[0].account_id.as_str());
    assert_eq!(info["requesterAccountId"], f.people[0].account_id.as_str());
    assert!(info["identity"]
        .as_str()
        .unwrap()
        .contains("never by display name"));
    assert!(
        unique(
            info["people"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p["handle"].as_str().unwrap())
                .collect()
        ),
        "{info}"
    );
    assert!(
        unique(
            info["agents"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| a["handle"].as_str().unwrap())
                .collect()
        ),
        "{info}"
    );

    // Routing follows the structured agent id, never the shared name.
    let mention = json!([{"targetKind":"agent","agentId":format!("cloud-agent:{gamma}"),"humanId":gamma,"label":"Kordishuyang","displayText":"@Kordishuyang","startUtf16":0,"lengthUtf16":13}]);
    for (structured, owner, allowed) in [
        (true, gamma, true),
        (true, beta, false),
        (false, gamma, false),
        (false, beta, false),
    ] {
        let logical = uuid::Uuid::new_v4().to_string();
        let mut message = json!({"id":logical,"senderAccountId":f.people[0].account_id,"senderKind":"human","text":"@Kordishuyang hi","createdAtMs":chrono::Utc::now().timestamp_millis()});
        if structured {
            message["mentions"] = mention.clone();
            message["targetCloudAgentId"] = json!(format!("cloud-agent:{gamma}"));
            message["targetCloudAgentOwnerAccountId"] = json!(gamma);
        }
        let participants: Vec<Value> = f
            .people
            .iter()
            .map(|p| json!({"accountId":p.account_id,"displayName":"Shu Yang"}))
            .collect();
        let envelope = json!({"kind":"group-message","groupId":f.session,"createdByAccountId":f.people[0].account_id,"actor":{"accountId":f.people[0].account_id,"displayName":"Alpha"},"participants":participants,"message":message});
        let body = format!(
            "kordi-cloud-group:{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(envelope.to_string())
        );
        insert_test_message(
            &f.pool,
            &f.people[0].account_id,
            f.conversation().await,
            &body,
        )
        .await;
        let claim = json!({"requestMessageId":logical,"sessionId":f.session,"ownerAccountId":owner,"requesterAccountId":f.people[0].account_id,"prompt":"hi","idempotencyKey":format!("dup:{logical}:{owner}")});
        let response = f
            .router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/agent-runs/claim",
                &f.people[0].token,
                claim,
            ))
            .await
            .unwrap();
        assert_eq!(
            response.status() == StatusCode::OK,
            allowed,
            "structured={structured} owner={owner}"
        );
    }
}
