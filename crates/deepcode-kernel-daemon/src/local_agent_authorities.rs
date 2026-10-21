//! Commit-time authorization indexes. Tool admission never replays journal history
//! or traverses delegation ancestry. Retained facts are used only for an explicit
//! conversation revision; ordinary writes update the affected session incrementally.
use crate::local_agent_store::LocalAgentStoreError;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

type RunKey = (String, String);
type ApprovalKey = (String, String, String);
type ScopeKey = (String, String, String);

#[derive(Clone, Default)]
struct Task {
    child: String,
    run: Option<String>,
    completed: bool,
}

#[derive(Clone)]
pub(crate) struct Grant {
    pub(crate) run: String,
    pub(crate) call: String,
    pub(crate) payload: Value,
    pub(crate) requested: Value,
    pub(crate) tool: Value,
    pub(crate) review: Option<String>,
    sequence: u64,
}

#[derive(Clone, Default)]
struct Session {
    facts: Vec<Arc<Value>>,
    active_plan: Option<(String, u64, String, Vec<Value>)>,
    runs: BTreeMap<String, bool>,
    settled: BTreeSet<String>,
    tasks: BTreeMap<RunKey, Task>,
    tools: BTreeMap<RunKey, Value>,
    requests: BTreeMap<ApprovalKey, Value>,
    reviews: BTreeMap<ApprovalKey, Value>,
    providers: BTreeMap<RunKey, Value>,
    grants: BTreeMap<String, Grant>,
    revoked: BTreeSet<String>,
    scopes: BTreeMap<ScopeKey, Value>,
    files: BTreeMap<(String, String), Vec<Value>>,
    browser: Option<String>,
}

#[derive(Clone, Default)]
pub(crate) struct KernelAuthorityModel {
    sessions: BTreeMap<String, Arc<Session>>,
    delegated: BTreeMap<RunKey, Result<Vec<Value>, LocalAgentStoreError>>,
}

impl KernelAuthorityModel {
    pub(crate) const EVENT_TYPES: &'static [&'static str] = &[
        "session.created",
        "run.started",
        "run.finishing",
        "run.settled",
        "plan.confirmed",
        "plan.revision.requested",
        "plan.superseded",
        "plan.cancelled",
        "plan.invalidated",
        "agent.task.created",
        "agent.task.started",
        "agent.task.completed",
        "tool.requested",
        "approval.requested",
        "approval.reviewed",
        "approval.resolved",
        "approval.revoked",
        "provider.turn.settled",
        "conversation.revised",
    ];

    pub(crate) fn observes(event: &Value) -> bool {
        event["type"]
            .as_str()
            .is_some_and(|kind| Self::EVENT_TYPES.contains(&kind))
    }

    pub(crate) fn apply(&mut self, event: &Value) {
        if !Self::observes(event) {
            return;
        }
        let id = text(event, "sessionId");
        let session = Arc::make_mut(self.sessions.entry(id).or_default());
        let mut fact = event.clone();
        if matches!(
            event["type"].as_str(),
            Some("session.created" | "run.started" | "run.finishing" | "run.settled")
        ) {
            fact["payload"] = json!({});
        } else if event["type"] == "provider.turn.settled" {
            fact["payload"] = json!({"providerRequestId": event["payload"]["providerRequestId"],
                "purpose": event["payload"]["purpose"], "outcome": event["payload"]["outcome"]});
        }
        session.facts.push(Arc::new(fact));
        if event["type"] == "conversation.revised" {
            let facts = std::mem::take(&mut session.facts);
            let ranges: Vec<_> = facts
                .iter()
                .filter(|fact| fact["type"] == "conversation.revised")
                .map(|fact| {
                    (
                        fact["payload"]["fromSequence"].as_u64().unwrap_or(0),
                        fact["payload"]["throughSequence"].as_u64().unwrap_or(0),
                    )
                })
                .collect();
            *session = Session::default();
            for fact in &facts {
                let sequence = fact["sequence"].as_u64().unwrap_or(0);
                if !ranges
                    .iter()
                    .any(|(from, through)| sequence >= *from && sequence <= *through)
                {
                    session.apply(fact);
                }
            }
            session.facts = facts;
        } else {
            session.apply(event);
        }
        if matches!(
            event["type"].as_str(),
            Some(
                "run.started"
                    | "run.finishing"
                    | "run.settled"
                    | "plan.confirmed"
                    | "plan.revision.requested"
                    | "plan.superseded"
                    | "plan.cancelled"
                    | "plan.invalidated"
                    | "agent.task.created"
                    | "agent.task.started"
                    | "agent.task.completed"
                    | "conversation.revised"
            )
        ) {
            self.publish_delegations();
        }
    }

    pub(crate) fn publish_grants(
        &mut self,
        session_id: Option<&str>,
        revoked: impl Fn(&str, &str) -> bool,
    ) {
        for (id, session) in &mut self.sessions {
            if session_id.is_some_and(|target| target != id) {
                continue;
            }
            let session = Arc::make_mut(session);
            session.scopes.clear();
            session.files.clear();
            session.browser = None;
            let mut grants: Vec<_> = session.grants.iter().collect();
            grants.sort_by_key(|(_, grant)| grant.sequence);
            for (authority, grant) in grants {
                if session.revoked.contains(authority) || revoked(id, authority) {
                    continue;
                }
                let preview = &grant.requested["preview"];
                if preview["authorizationScope"] == "sessionBrowser" {
                    session.browser =
                        (grant.payload["decision"] == "allow").then(|| authority.clone());
                }
                if grant.payload["decision"] != "allow"
                    || grant.payload["source"].as_str().unwrap_or("user") != "user"
                {
                    continue;
                }
                let Some(scope) = grant.payload["authorizationScope"].as_str() else {
                    continue;
                };
                if !preview["authorizationScopes"]
                    .as_array()
                    .is_some_and(|scopes| scopes.iter().any(|offered| offered == scope))
                {
                    continue;
                }
                let run = if scope.starts_with("session") {
                    String::new()
                } else {
                    grant.run.clone()
                };
                let context = &preview["authorizationContext"];
                if matches!(scope, "runFiles" | "sessionFiles") {
                    session
                        .files
                        .entry((run, context["fileEnvironment"].to_string()))
                        .or_default()
                        .push(context["fileAccess"].clone());
                    continue;
                }
                let mut binding = context.clone();
                if matches!(scope, "runHostShell" | "sessionHostShell") {
                    if let Some(binding) = binding.as_object_mut() {
                        for key in ["command", "cwd", "terminal", "workspaceMode", "toolName"] {
                            binding.remove(key);
                        }
                    }
                }
                if matches!(scope, "runNetwork" | "sessionNetwork") {
                    binding = context["networkEnvironment"].clone();
                }
                if matches!(scope, "runContainer" | "sessionContainer") {
                    binding = context["container"].clone();
                }
                session.scopes.insert((run, scope.into(), binding.to_string()),
                    json!({"decision":"allow","source":"user","authorityId":authority,"authorizationScope":scope}));
            }
        }
    }

    pub(crate) fn remove(&mut self, id: &str) {
        self.sessions.remove(id);
        self.publish_delegations();
    }
    pub(crate) fn has_run(&self, session: &str, run: &str) -> bool {
        self.sessions
            .get(session)
            .is_some_and(|s| s.runs.contains_key(run))
    }
    pub(crate) fn settled(&self, session: &str, run: &str) -> bool {
        self.sessions
            .get(session)
            .is_some_and(|s| s.settled.contains(run))
    }
    pub(crate) fn active_plan(&self, session: &str) -> Option<Vec<Value>> {
        self.sessions
            .get(session)?
            .active_plan
            .as_ref()
            .map(|plan| plan.3.clone())
    }
    pub(crate) fn delegated(
        &self,
        session: &str,
        run: &str,
    ) -> Result<Vec<Value>, LocalAgentStoreError> {
        self.delegated
            .get(&(session.into(), run.into()))
            .cloned()
            .unwrap_or(Ok(Vec::new()))
    }
    pub(crate) fn grant(&self, session: &str, authority: &str) -> Option<&Grant> {
        self.sessions.get(session)?.grants.get(authority)
    }
    pub(crate) fn revoked(&self, session: &str, authority: &str) -> bool {
        self.sessions
            .get(session)
            .is_some_and(|s| s.revoked.contains(authority))
    }
    pub(crate) fn browser(&self, session: &str) -> Option<String> {
        self.sessions.get(session)?.browser.clone()
    }
    pub(crate) fn execution(
        &self,
        session: &str,
        run: &str,
        scope: &str,
        context: &Value,
    ) -> Option<Value> {
        let run = if scope.starts_with("session") {
            ""
        } else {
            run
        };
        self.sessions
            .get(session)?
            .scopes
            .get(&(run.into(), scope.into(), context.to_string()))
            .cloned()
    }
    pub(crate) fn files(&self, session: &str, run: &str, environment: &Value) -> Vec<Value> {
        let Some(session) = self.sessions.get(session) else {
            return Vec::new();
        };
        ["", run]
            .into_iter()
            .flat_map(|run| {
                session
                    .files
                    .get(&(run.into(), environment.to_string()))
                    .into_iter()
                    .flatten()
                    .cloned()
            })
            .collect()
    }

    fn publish_delegations(&mut self) {
        let mut parents: BTreeMap<RunKey, Vec<RunKey>> = BTreeMap::new();
        for (id, session) in &self.sessions {
            for ((run, _), task) in &session.tasks {
                let Some(child_run) = &task.run else {
                    continue;
                };
                if task.completed
                    || session.runs.get(run) != Some(&true)
                    || !self
                        .sessions
                        .get(&task.child)
                        .is_some_and(|child| child.runs.get(child_run) == Some(&true))
                {
                    continue;
                }
                parents
                    .entry((task.child.clone(), child_run.clone()))
                    .or_default()
                    .push((id.clone(), run.clone()));
            }
        }
        self.delegated.clear();
        for child in parents.keys() {
            let result = (|| {
                let mut current = child.clone();
                let mut visited = BTreeSet::new();
                let mut authorities = Vec::new();
                loop {
                    if !visited.insert(current.clone()) {
                        return Err(lineage_error("Agent task lineage contains a cycle."));
                    }
                    let Some(candidates) = parents.get(&current) else {
                        break;
                    };
                    if candidates.len() != 1 {
                        return Err(lineage_error(
                            "A child run has multiple active delegations.",
                        ));
                    }
                    let parent = &candidates[0];
                    if let Some(plan) = self
                        .sessions
                        .get(&parent.0)
                        .and_then(|s| s.active_plan.as_ref())
                    {
                        authorities.extend(
                            plan.3
                                .iter()
                                .filter(|a| a["sessionId"] == parent.0 && a["runId"] == parent.1)
                                .cloned(),
                        );
                    }
                    current = parent.clone();
                }
                Ok(authorities)
            })();
            self.delegated.insert(child.clone(), result);
        }
    }
}

impl Session {
    fn apply(&mut self, event: &Value) {
        let payload = &event["payload"];
        let run = text(event, "runId");
        let call = text(event, "callId");
        let approval_key = (run.clone(), call.clone(), text(payload, "approvalId"));
        match event["type"].as_str().unwrap_or("") {
            "run.started" => {
                self.runs.insert(run, true);
            }
            "run.finishing" | "run.settled" => {
                self.runs.insert(run.clone(), false);
                if event["type"] == "run.settled" {
                    self.settled.insert(run.clone());
                }
                if self.active_plan.as_ref().is_some_and(|plan| plan.2 == run) {
                    self.active_plan = None;
                }
            }
            "plan.confirmed" => {
                self.active_plan = Some((
                    text(payload, "planId"),
                    payload["revision"].as_u64().unwrap_or(0),
                    run,
                    payload["authorities"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default(),
                ))
            }
            "plan.revision.requested"
            | "plan.superseded"
            | "plan.cancelled"
            | "plan.invalidated" => {
                if self.active_plan.as_ref().is_some_and(|plan| {
                    payload["planId"] == plan.0 && payload["revision"] == plan.1
                }) {
                    self.active_plan = None;
                }
            }
            "agent.task.created" => {
                self.tasks
                    .entry((run, text(payload, "taskId")))
                    .or_default()
                    .child = text(payload, "agentSessionId");
            }
            "agent.task.started" => {
                self.tasks
                    .entry((run, text(payload, "taskId")))
                    .or_default()
                    .run = Some(text(payload, "childRunId"));
            }
            "agent.task.completed" => {
                self.tasks
                    .entry((run, text(payload, "taskId")))
                    .or_default()
                    .completed = true;
            }
            "tool.requested" => {
                self.tools.insert((run, call), payload.clone());
            }
            "approval.requested" => {
                self.requests.insert(approval_key, payload.clone());
            }
            "approval.reviewed" => {
                if self
                    .requests
                    .get(&approval_key)
                    .is_some_and(|request| request["preview"]["approvalReviewer"] == "agent")
                    && self
                        .providers
                        .get(&(run, text(payload, "providerRequestId")))
                        .is_some_and(|provider| {
                            provider["purpose"] == "approvalReview"
                                && provider["outcome"] == "completed"
                        })
                {
                    self.reviews.insert(approval_key, payload.clone());
                }
            }
            "provider.turn.settled" => {
                self.providers
                    .insert((run, text(payload, "providerRequestId")), payload.clone());
            }
            "approval.revoked" => {
                self.revoked.insert(text(payload, "authorityId"));
            }
            "approval.resolved" => {
                let requested = self
                    .requests
                    .get(&approval_key)
                    .cloned()
                    .unwrap_or(Value::Null);
                let review = self
                    .reviews
                    .get(&approval_key)
                    .filter(|_| payload.get("authorizationScope").is_none())
                    .map(|review| text(review, "decision"));
                self.grants.insert(
                    text(payload, "authorityId"),
                    Grant {
                        run: run.clone(),
                        call: call.clone(),
                        payload: payload.clone(),
                        requested,
                        tool: self.tools.get(&(run, call)).cloned().unwrap_or(Value::Null),
                        review,
                        sequence: event["sequence"].as_u64().unwrap_or(0),
                    },
                );
            }
            _ => {}
        }
    }
}
fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or("").into()
}
fn lineage_error(message: &str) -> LocalAgentStoreError {
    LocalAgentStoreError::new("agent_task_lineage_invalid", message)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fact(
        model: &mut KernelAuthorityModel,
        session: &str,
        run: &str,
        sequence: u64,
        kind: &str,
        payload: Value,
    ) {
        model.apply(&json!({"type":kind,"sessionId":session,"runId":run,"callId":"call","sequence":sequence,"payload":payload}));
        model.publish_grants(None, |_, _| false);
    }
    fn grant(model: &mut KernelAuthorityModel, sequence: u64, authority: &str, decision: &str) {
        fact(
            model,
            "s",
            "r",
            sequence,
            "approval.requested",
            json!({"approvalId":authority,"preview":{
            "authorizationScope":"sessionBrowser", "authorizationScopes":["sessionCommand", "sessionFiles"],
            "authorizationContext":{"command":"ls","fileEnvironment":{"id":"local"},"fileAccess":{"path":"/tmp/a"}}}}),
        );
        fact(
            model,
            "s",
            "r",
            sequence + 1,
            "approval.resolved",
            json!({"approvalId":authority,"authorityId":authority,
            "decision":decision,"source":"user","authorizationScope":"sessionCommand"}),
        );
    }
    #[test]
    fn revisions_republish_scope_browser_and_identity_indexes() {
        let mut model = KernelAuthorityModel::default();
        grant(&mut model, 1, "old", "allow");
        grant(&mut model, 3, "new", "deny");
        assert!(model.browser("s").is_none());
        fact(
            &mut model,
            "s",
            "r",
            5,
            "conversation.revised",
            json!({"fromSequence":3,"throughSequence":4}),
        );
        assert_eq!(model.browser("s").as_deref(), Some("old"));
        assert!(model.grant("s", "new").is_none());
        let context =
            json!({"command":"ls","fileEnvironment":{"id":"local"},"fileAccess":{"path":"/tmp/a"}});
        assert_eq!(
            model
                .execution("s", "later", "sessionCommand", &context)
                .unwrap()["authorityId"],
            "old"
        );
        assert!(model
            .execution("s", "later", "sessionCommand", &json!({"command":"rm"}))
            .is_none());
        fact(
            &mut model,
            "s",
            "r",
            6,
            "approval.revoked",
            json!({"authorityId":"old"}),
        );
        assert!(model
            .execution("s", "later", "sessionCommand", &context)
            .is_none());
        assert!(model.browser("s").is_none());
    }
    #[test]
    fn delegation_indexes_keep_original_identity_and_change_at_task_and_run_boundaries() {
        let mut model = KernelAuthorityModel::default();
        for (id, run) in [("p", "rp"), ("c", "rc"), ("g", "rg")] {
            fact(&mut model, id, run, 1, "run.started", json!({}));
        }
        let authority = json!({"sessionId":"p","runId":"rp","authorityId":"original"});
        fact(
            &mut model,
            "p",
            "rp",
            2,
            "plan.confirmed",
            json!({"planId":"plan","revision":1,"authorities":[authority]}),
        );
        for (parent, run, child, child_run) in [("p", "rp", "c", "rc"), ("c", "rc", "g", "rg")] {
            fact(
                &mut model,
                parent,
                run,
                3,
                "agent.task.created",
                json!({"taskId":"task","agentSessionId":child}),
            );
            fact(
                &mut model,
                parent,
                run,
                4,
                "agent.task.started",
                json!({"taskId":"task","childRunId":child_run}),
            );
        }
        assert_eq!(model.delegated("g", "rg").unwrap(), vec![authority.clone()]);
        let before = model.clone();
        fact(
            &mut model,
            "p",
            "rp",
            5,
            "agent.task.completed",
            json!({"taskId":"task"}),
        );
        assert!(model.delegated("g", "rg").unwrap().is_empty());
        assert_eq!(before.delegated("g", "rg").unwrap(), vec![authority]);
        model = before;
        fact(&mut model, "p", "rp", 5, "run.finishing", json!({}));
        assert!(model.delegated("g", "rg").unwrap().is_empty());
        assert!(model.active_plan("p").is_none());
        model.remove("c");
        assert!(model.delegated("g", "rg").unwrap().is_empty());
    }
    #[test]
    fn automatic_review_cannot_borrow_a_provider_completion_that_arrived_after_review() {
        let mut model = KernelAuthorityModel::default();
        fact(
            &mut model,
            "s",
            "r",
            1,
            "approval.requested",
            json!({"approvalId":"a","preview":{"approvalReviewer":"agent"}}),
        );
        fact(
            &mut model,
            "s",
            "r",
            2,
            "approval.reviewed",
            json!({"approvalId":"a","providerRequestId":"late","decision":"allow"}),
        );
        fact(
            &mut model,
            "s",
            "r",
            3,
            "provider.turn.settled",
            json!({"providerRequestId":"late","purpose":"approvalReview","outcome":"completed"}),
        );
        fact(
            &mut model,
            "s",
            "r",
            4,
            "approval.resolved",
            json!({"approvalId":"a","authorityId":"grant","decision":"allow"}),
        );
        assert!(model.grant("s", "grant").unwrap().review.is_none());
    }
}
