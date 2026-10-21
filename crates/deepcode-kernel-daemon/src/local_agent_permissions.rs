//! Kernel-owned permission projection. Commits update the affected subtree;
//! tool admission reads a compiled snapshot without replaying parent history.
use crate::local_agent_kernel::LocalAgentPermissionPolicy;
use crate::local_agent_store::LocalAgentStoreError;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::Arc;

#[derive(Clone)]
struct PlanReviewPermission {
    request_id: String,
    can_approve: bool,
    allowed: bool,
}

#[derive(Clone)]
struct SessionPermissions {
    parent: Option<String>,
    attached: bool,
    base: Value,
    overrides: Map<String, Value>,
    effective: Arc<LocalAgentPermissionPolicy>,
    approvals: BTreeSet<String>,
    pending_reviews: BTreeSet<String>,
    cancelled_reviews: BTreeSet<String>,
    automatic_plans: BTreeSet<String>,
    reviewed_plans: BTreeSet<String>,
    plan_reviews: BTreeMap<(String, String, u64), PlanReviewPermission>,
    revoked: BTreeSet<String>,
}

#[derive(Clone, Default)]
pub(crate) struct KernelPermissionModel {
    pub(crate) authorities: crate::local_agent_authorities::KernelAuthorityModel,
    revision: u64,
    sessions: BTreeMap<String, SessionPermissions>,
    children: BTreeMap<String, BTreeSet<String>>,
}

impl KernelPermissionModel {
    const PERMISSION_EVENT_TYPES: &'static [&'static str] = &[
        "session.created",
        "run.started",
        "session.permissions.updated",
        "approval.requested",
        "approval.resolved",
        "plan.review.requested",
        "plan.reviewed",
        "plan.cancelled",
        "plan.invalidated",
        "run.finishing",
        "plan.confirmed",
    ];

    pub(crate) fn observed_event_types() -> impl Iterator<Item = &'static str> {
        Self::PERMISSION_EVENT_TYPES
            .iter()
            .chain(crate::local_agent_authorities::KernelAuthorityModel::EVENT_TYPES)
            .copied()
    }

    pub(crate) fn observes(event: &Value) -> bool {
        Self::observes_permissions(event)
            || crate::local_agent_authorities::KernelAuthorityModel::observes(event)
    }
    fn observes_permissions(event: &Value) -> bool {
        event["type"]
            .as_str()
            .is_some_and(|kind| Self::PERMISSION_EVENT_TYPES.contains(&kind))
    }

    pub(crate) fn apply(&mut self, event: &Value) -> Result<(), LocalAgentStoreError> {
        self.apply_event(event, true)
    }

    pub(crate) fn restore(&mut self, event: &Value) -> Result<(), LocalAgentStoreError> {
        self.apply_event(event, false)
    }

    fn apply_event(&mut self, event: &Value, admit_new: bool) -> Result<(), LocalAgentStoreError> {
        self.apply_permissions_event(event, admit_new)?;
        self.authorities.apply(event);
        if matches!(
            event["type"].as_str(),
            Some(
                "session.created"
                    | "run.started"
                    | "session.permissions.updated"
                    | "approval.resolved"
                    | "approval.revoked"
                    | "conversation.revised"
            )
        ) {
            let all = matches!(
                event["type"].as_str(),
                Some("session.created" | "run.started" | "session.permissions.updated")
            );
            let sessions = &self.sessions;
            self.authorities.publish_grants(
                if all {
                    None
                } else {
                    event["sessionId"].as_str()
                },
                |id, grant| {
                    sessions
                        .get(id)
                        .is_some_and(|session| session.revoked.contains(grant))
                },
            );
        }
        Ok(())
    }
    fn apply_permissions_event(
        &mut self,
        event: &Value,
        admit_new: bool,
    ) -> Result<(), LocalAgentStoreError> {
        if !Self::observes_permissions(event) {
            return Ok(());
        }
        let session_id = event["sessionId"].as_str().ok_or_else(invalid_model)?;
        let payload = &event["payload"];
        if event["type"] == "session.created" {
            let parent = payload["agentContext"]["parentSessionId"]
                .as_str()
                .map(str::to_owned);
            if let Some(parent) = &parent {
                self.children
                    .entry(parent.clone())
                    .or_default()
                    .insert(session_id.into());
            }
            let base = crate::settings_api::permission_settings(&json!({}));
            self.sessions.insert(
                session_id.into(),
                SessionPermissions {
                    parent,
                    attached: false,
                    effective: compile(&base)?,
                    base,
                    overrides: payload["recipe"]["permissions"]
                        .as_object()
                        .cloned()
                        .unwrap_or_default(),
                    approvals: BTreeSet::new(),
                    pending_reviews: BTreeSet::new(),
                    cancelled_reviews: BTreeSet::new(),
                    automatic_plans: BTreeSet::new(),
                    reviewed_plans: BTreeSet::new(),
                    plan_reviews: BTreeMap::new(),
                    revoked: BTreeSet::new(),
                },
            );
        } else {
            let session = self
                .sessions
                .get_mut(session_id)
                .ok_or_else(invalid_model)?;
            match event["type"].as_str() {
                Some("run.started") => {
                    session.base = crate::settings_api::permission_settings(
                        &payload["runtimeSnapshot"]["permissions"],
                    );
                }
                Some("session.permissions.updated") => {
                    if payload["patches"]
                        .get("agent.permissions.workspaceMutation")
                        .is_some()
                    {
                        for review in session.plan_reviews.values_mut() {
                            review.can_approve = false;
                        }
                    }
                    // An explicit policy publication invalidates outstanding call
                    // approvals even when the selected value is unchanged.
                    if payload["patches"].as_object().is_some_and(|patches| {
                        patches.keys().any(|key| {
                            matches!(
                                key.as_str(),
                                "agent.permissions.shell"
                                    | "agent.permissions.shellAccess"
                                    | "agent.permissions.commandRules"
                                    | "agent.permissions.commandDenylist"
                                    | "agent.permissions.networkRead"
                            )
                        })
                    }) {
                        session.revoked.append(&mut session.approvals);
                        session
                            .cancelled_reviews
                            .append(&mut session.pending_reviews);
                    }
                    session.overrides.extend(
                        payload["patches"]
                            .as_object()
                            .ok_or_else(invalid_model)?
                            .clone(),
                    );
                }
                Some("approval.requested") => {
                    if payload["preview"]["approvalReviewer"] == "agent" {
                        let reviews = if session.attached
                            && session.effective.settings["agent.permissions.shell"] == "review"
                        {
                            &mut session.pending_reviews
                        } else {
                            &mut session.cancelled_reviews
                        };
                        reviews.insert(
                            payload["approvalId"]
                                .as_str()
                                .ok_or_else(invalid_model)?
                                .into(),
                        );
                    }
                    return Ok(());
                }
                Some("approval.resolved") => {
                    if payload["source"] == "agent" {
                        let id = payload["approvalId"].as_str().ok_or_else(invalid_model)?;
                        session.pending_reviews.remove(id);
                        if session.cancelled_reviews.contains(id)
                            || session.effective.settings["agent.permissions.shell"] != "review"
                        {
                            // Retain the review as a fact; it cannot mint a grant after
                            // the producer withdrew the authority that requested it.
                            session.revoked.insert(
                                payload["authorityId"]
                                    .as_str()
                                    .ok_or_else(invalid_model)?
                                    .into(),
                            );
                            return Ok(());
                        }
                    }
                    if payload["decision"] == "allow" {
                        let approvals = if session.attached {
                            &mut session.approvals
                        } else {
                            &mut session.revoked
                        };
                        approvals.insert(
                            payload["authorityId"]
                                .as_str()
                                .ok_or_else(invalid_model)?
                                .into(),
                        );
                    }
                    return Ok(());
                }
                Some("plan.review.requested") => {
                    session.plan_reviews.insert(
                        plan_review_key(event)?,
                        PlanReviewPermission {
                            request_id: payload["providerRequestId"]
                                .as_str()
                                .ok_or_else(invalid_model)?
                                .into(),
                            can_approve: session.attached
                                && session.effective.settings
                                    ["agent.permissions.workspaceMutation"]
                                    == "review",
                            allowed: false,
                        },
                    );
                    return Ok(());
                }
                Some("plan.reviewed") => {
                    let review = session
                        .plan_reviews
                        .get_mut(&plan_review_key(event)?)
                        .ok_or_else(invalid_model)?;
                    if payload["providerRequestId"].as_str() != Some(review.request_id.as_str()) {
                        return Err(LocalAgentStoreError::new(
                            "plan_review_identity_mismatch",
                            "Plan review belongs to another request.",
                        ));
                    }
                    review.allowed = review.can_approve
                        && payload["decision"] == "allow"
                        && payload.get("error").is_none();
                    return Ok(());
                }
                Some("plan.cancelled" | "plan.invalidated") => {
                    session.plan_reviews.remove(&plan_review_key(event)?);
                    return Ok(());
                }
                Some("run.finishing") => {
                    let run = event["runId"].as_str().ok_or_else(invalid_model)?;
                    session.plan_reviews.retain(|key, _| key.0 != run);
                    return Ok(());
                }
                Some("plan.confirmed") => {
                    if payload["source"] == "agent" {
                        let reviewed = session.effective.settings
                            ["agent.permissions.workspaceMutation"]
                            == "review"
                            && session
                                .plan_reviews
                                .get(&plan_review_key(event)?)
                                .is_some_and(|review| review.can_approve && review.allowed);
                        let granted = session.attached
                            && (session.effective.settings["agent.permissions.workspaceMutation"]
                                == "allow"
                                || reviewed);
                        if admit_new && !granted {
                            return Err(LocalAgentStoreError::new(
                                "plan_delegation_missing",
                                "The Kernel has no valid permission or matching independent review for this Plan.",
                            ));
                        }
                        // An archived child can outlive its deleted parent. Replay
                        // preserves its history while keeping those grants inert.
                        let plans = if granted && reviewed {
                            &mut session.reviewed_plans
                        } else if granted {
                            &mut session.automatic_plans
                        } else {
                            &mut session.revoked
                        };
                        for authority in payload["authorities"]
                            .as_array()
                            .ok_or_else(invalid_model)?
                        {
                            plans.insert(
                                authority["authorityId"]
                                    .as_str()
                                    .ok_or_else(invalid_model)?
                                    .into(),
                            );
                        }
                        if reviewed {
                            session.plan_reviews.remove(&plan_review_key(event)?);
                        }
                    }
                    return Ok(());
                }
                _ => unreachable!(),
            }
        }
        self.revision += 1;
        self.refresh_subtree(session_id)
    }

    pub(crate) fn publication(&self, session_id: &str, descendants: bool) -> Value {
        let mut views = Map::new();
        let mut queue = VecDeque::from([session_id.to_owned()]);
        while let Some(id) = queue.pop_front() {
            if let Some(session) = self.sessions.get(&id) {
                views.insert(
                    id.clone(),
                    json!({"revision": self.revision, "settings": session.effective.settings}),
                );
            }
            if descendants {
                if let Some(children) = self.children.get(&id) {
                    queue.extend(children.iter().cloned());
                }
            }
        }
        Value::Object(views)
    }

    pub(crate) fn effective(
        &self,
        session_id: &str,
    ) -> Result<Arc<LocalAgentPermissionPolicy>, LocalAgentStoreError> {
        self.sessions
            .get(session_id)
            .map(|session| session.effective.clone())
            .ok_or_else(invalid_model)
    }

    /// Called once when preparing a run. The parent ceiling is already resolved.
    pub(crate) fn for_run(
        &self,
        session_id: &str,
        defaults: &Value,
    ) -> Result<Value, LocalAgentStoreError> {
        let session = self.sessions.get(session_id).ok_or_else(invalid_model)?;
        self.resolve(session, defaults)
    }

    pub(crate) fn revoked(&self, session_id: &str, authority_id: &str) -> bool {
        self.sessions
            .get(session_id)
            .is_some_and(|session| session.revoked.contains(authority_id))
            || self.authorities.revoked(session_id, authority_id)
    }

    pub(crate) fn remove(&mut self, session_id: &str) -> Result<(), LocalAgentStoreError> {
        self.authorities.remove(session_id);
        self.revision += 1;
        if let Some(session) = self.sessions.remove(session_id) {
            if let Some(parent) = session.parent {
                if let Some(children) = self.children.get_mut(&parent) {
                    children.remove(session_id);
                }
            }
        }
        // Retained descendants lose their absent parent's grant immediately.
        let children = self.children.get(session_id).cloned().unwrap_or_default();
        for child in children {
            self.refresh_subtree(&child)?;
        }
        let sessions = &self.sessions;
        self.authorities.publish_grants(None, |id, grant| {
            sessions
                .get(id)
                .is_some_and(|session| session.revoked.contains(grant))
        });
        Ok(())
    }

    fn resolve(
        &self,
        session: &SessionPermissions,
        base: &Value,
    ) -> Result<Value, LocalAgentStoreError> {
        let mut settings = crate::settings_api::permission_settings(base);
        settings
            .as_object_mut()
            .expect("permission object")
            .extend(session.overrides.clone());
        if let Some(parent) = &session.parent {
            let missing_parent = crate::settings_api::permission_settings(&json!({
                "agent.permissions.networkRead":"deny", "agent.permissions.external":"deny",
            }));
            let ceiling = self
                .sessions
                .get(parent)
                .map(|session| &session.effective.settings)
                .unwrap_or(&missing_parent);
            intersect(&mut settings, ceiling)?;
        }
        Ok(settings)
    }

    fn refresh_subtree(&mut self, root: &str) -> Result<(), LocalAgentStoreError> {
        let mut pending = VecDeque::from([root.to_owned()]);
        let mut visited = BTreeSet::new();
        while let Some(id) = pending.pop_front() {
            if !visited.insert(id.clone()) {
                return Err(invalid_model());
            }
            let session = self.sessions.get(&id).ok_or_else(invalid_model)?;
            let attached = session.parent.as_ref().is_none_or(|parent| {
                self.sessions
                    .get(parent)
                    .is_some_and(|parent| parent.attached)
            });
            let settings = self.resolve(session, &session.base)?;
            let mutation_restricted = settings["agent.permissions.workspaceMutation"] != "allow"
                && session.effective.settings["agent.permissions.workspaceMutation"] == "allow";
            let plan_review_changed = settings["agent.permissions.workspaceMutation"]
                != session.effective.settings["agent.permissions.workspaceMutation"];
            let plan_review_disabled = settings["agent.permissions.workspaceMutation"] != "review";
            let execution_changed =
                settings
                    .as_object()
                    .expect("permission object")
                    .iter()
                    .any(|(key, value)| {
                        key != "agent.permissions.workspaceMutation"
                            && key != "agent.permissions.engineeringDecisions"
                            && session.effective.settings.get(key) != Some(value)
                    });
            let effective = compile(&settings)?;
            let session = self.sessions.get_mut(&id).expect("existing session");
            if mutation_restricted || !attached {
                session.revoked.append(&mut session.automatic_plans);
            }
            if plan_review_disabled || !attached {
                session.revoked.append(&mut session.reviewed_plans);
            }
            if plan_review_changed || !attached {
                for review in session.plan_reviews.values_mut() {
                    review.can_approve = false;
                }
            }
            if execution_changed || !attached {
                // A cached approval cannot keep a descendant's old execution policy alive.
                session.revoked.append(&mut session.approvals);
                session
                    .cancelled_reviews
                    .append(&mut session.pending_reviews);
            }
            session.effective = effective;
            session.attached = attached;
            if let Some(children) = self.children.get(&id) {
                pending.extend(children.iter().cloned());
            }
        }
        Ok(())
    }
}

fn plan_review_key(event: &Value) -> Result<(String, String, u64), LocalAgentStoreError> {
    Ok((
        event["runId"].as_str().ok_or_else(invalid_model)?.into(),
        event["payload"]["planId"]
            .as_str()
            .ok_or_else(invalid_model)?
            .into(),
        event["payload"]["revision"]
            .as_u64()
            .ok_or_else(invalid_model)?,
    ))
}

fn invalid_model() -> LocalAgentStoreError {
    LocalAgentStoreError::new(
        "kernel_permission_model_invalid",
        "Kernel permission lineage or event is invalid.",
    )
}

fn compile(settings: &Value) -> Result<Arc<LocalAgentPermissionPolicy>, LocalAgentStoreError> {
    LocalAgentPermissionPolicy::from_settings(settings)
        .map(Arc::new)
        .map_err(|error| LocalAgentStoreError::new(error.code, error.message))
}

/// Intersection preserves each local restriction and the latest inherited ceiling.
fn intersect(settings: &mut Value, ceiling: &Value) -> Result<(), LocalAgentStoreError> {
    let local_shell_allowed = settings["agent.permissions.shell"] == "allow"
        && settings["agent.permissions.shellAccess"] == "full";
    let parent_shell_allowed = ceiling["agent.permissions.shell"] == "allow"
        && ceiling["agent.permissions.shellAccess"] == "full";
    for (key, levels) in [
        ("workspaceMutation", &["plan", "review", "allow"][..]),
        ("engineeringDecisions", &["ask", "delegate"]),
        ("shell", &["ask", "review", "allow"]),
        ("shellAccess", &["workspace", "full"]),
        ("networkRead", &["deny", "ask", "allow"]),
        ("external", &["deny", "ask", "allow"]),
    ] {
        let key = format!("agent.permissions.{key}");
        let rank = |value: &Value| {
            levels
                .iter()
                .position(|item| value.as_str() == Some(item))
                .ok_or_else(invalid_model)
        };
        if rank(&ceiling[&key])? < rank(&settings[&key])? {
            settings[&key] = ceiling[&key].clone();
        }
    }
    let deny_key = "agent.permissions.commandDenylist";
    let mut denylist = settings[deny_key]
        .as_array()
        .ok_or_else(invalid_model)?
        .clone();
    for rule in ceiling[deny_key].as_array().ok_or_else(invalid_model)? {
        if !denylist.contains(rule) {
            denylist.push(rule.clone());
        }
    }
    settings[deny_key] = json!(denylist);
    let roots_key = "agent.permissions.runtimeReadRoots";
    let ceiling_roots = ceiling[roots_key].as_array().ok_or_else(invalid_model)?;
    // Exact intersection is conservative across symlinks and execution platforms.
    settings[roots_key] = json!(settings[roots_key]
        .as_array()
        .ok_or_else(invalid_model)?
        .iter()
        .filter(|root| ceiling_roots.contains(root))
        .cloned()
        .collect::<Vec<_>>());

    let rules_key = "agent.permissions.commandRules";
    let rules = |value: &Value| -> Result<Vec<Value>, LocalAgentStoreError> {
        serde_json::from_str(value[rules_key].as_str().ok_or_else(invalid_model)?)
            .map_err(|_| invalid_model())
    };
    let local = rules(settings)?;
    let parent = rules(ceiling)?;
    let decision = |rules: &[Value], context: &Value, fallback: bool| -> &'static str {
        if rules
            .iter()
            .any(|rule| rule["context"] == *context && rule["decision"] == "deny")
        {
            "deny"
        } else if rules
            .iter()
            .any(|rule| rule["context"] == *context && rule["decision"] == "ask")
        {
            "ask"
        } else if rules
            .iter()
            .any(|rule| rule["context"] == *context && rule["decision"] == "allow")
            || fallback
        {
            "allow"
        } else {
            "ask"
        }
    };
    let mut combined: Vec<Value> = Vec::new();
    for rule in local.iter().chain(&parent) {
        let context = &rule["context"];
        if combined.iter().any(|rule| rule["context"] == *context) {
            continue;
        }
        let decisions = [
            decision(&local, context, local_shell_allowed),
            decision(&parent, context, parent_shell_allowed),
        ];
        let decision = if decisions.contains(&"deny") {
            "deny"
        } else if decisions.contains(&"ask") {
            "ask"
        } else {
            "allow"
        };
        combined.push(json!({"context":context, "decision":decision}));
    }
    settings[rules_key] = json!(serde_json::to_string(&combined).expect("permission rules"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create(
        model: &mut KernelPermissionModel,
        id: &str,
        parent: Option<&str>,
        permissions: Value,
    ) {
        model.apply(&json!({"type":"session.created","sessionId":id,
            "payload":{"agentContext":{"parentSessionId":parent},"recipe":{"permissions":permissions}}})).unwrap();
    }

    #[test]
    fn parent_updates_invalidate_pending_reviews_before_the_results_arrive() {
        let mut model = KernelPermissionModel::default();
        let permissions = json!({"agent.permissions.shell":"review"});
        create(&mut model, "parent", None, permissions.clone());
        create(&mut model, "child", Some("parent"), permissions);
        model
            .apply(
                &json!({"type":"approval.requested", "sessionId":"child", "payload":{
            "approvalId":"review:pending", "preview":{"approvalReviewer":"agent"}}}),
            )
            .unwrap();
        for mode in ["ask", "review"] {
            model
                .apply(
                    &json!({"type":"session.permissions.updated", "sessionId":"parent",
                "payload":{"patches":{"agent.permissions.shell":mode}}}),
                )
                .unwrap();
        }
        model.apply(&json!({"type":"approval.resolved", "sessionId":"child", "payload":{
            "approvalId":"review:pending", "authorityId":"grant:late", "source":"agent", "decision":"allow"}})).unwrap();
        assert!(model.revoked("child", "grant:late"));
        model
            .apply(
                &json!({"type":"approval.requested", "sessionId":"child", "payload":{
            "approvalId":"review:new", "preview":{"approvalReviewer":"agent"}}}),
            )
            .unwrap();
        model.apply(&json!({"type":"approval.resolved", "sessionId":"child", "payload":{
            "approvalId":"review:new", "authorityId":"grant:new", "source":"agent", "decision":"allow"}})).unwrap();
        assert!(!model.revoked("child", "grant:new"));
    }

    #[test]
    fn independent_plan_review_is_required_and_cannot_borrow_shell_or_stale_decisions() {
        let mut model = KernelPermissionModel::default();
        create(
            &mut model,
            "root",
            None,
            json!({"agent.permissions.workspaceMutation":"review","agent.permissions.shell":"review"}),
        );
        let mut plan = json!({"type":"plan.confirmed","sessionId":"root","runId":"run:review",
            "payload":{"planId":"plan:review","revision":1,"source":"agent","authorities":[{"authorityId":"grant:plan","sessionId":"root"}]}});
        assert_eq!(
            model.apply(&plan).unwrap_err().code,
            "plan_delegation_missing"
        );
        model.apply(&json!({"type":"approval.requested","sessionId":"root","payload":{"approvalId":"shell:review","preview":{"approvalReviewer":"agent"}}})).unwrap();
        model.apply(&json!({"type":"approval.resolved","sessionId":"root","payload":{"approvalId":"shell:review","authorityId":"grant:shell","source":"agent","decision":"allow"}})).unwrap();
        assert_eq!(
            model.apply(&plan).unwrap_err().code,
            "plan_delegation_missing"
        );
        let requested = json!({"type":"plan.review.requested","sessionId":"root","runId":"run:review",
            "payload":{"planId":"plan:review","revision":1,"providerRequestId":"request:plan"}});
        model.apply(&requested).unwrap();
        model
            .apply(
                &json!({"type":"session.permissions.updated","sessionId":"root",
            "payload":{"patches":{"agent.permissions.shell":"ask"}}}),
            )
            .unwrap();
        let mut reviewed = requested.clone();
        reviewed["type"] = json!("plan.reviewed");
        reviewed["payload"]["decision"] = json!("allow");
        reviewed["payload"]["providerRequestId"] = json!("request:shell");
        assert_eq!(
            model.apply(&reviewed).unwrap_err().code,
            "plan_review_identity_mismatch"
        );
        reviewed["payload"]["providerRequestId"] = json!("request:plan");
        model.apply(&reviewed).unwrap();
        model.apply(&plan).unwrap();
        assert!(!model.revoked("root", "grant:plan"));
        model.apply(&requested).unwrap();
        for mode in ["plan", "review"] {
            model
                .apply(
                    &json!({"type":"session.permissions.updated","sessionId":"root",
                "payload":{"patches":{"agent.permissions.workspaceMutation":mode}}}),
                )
                .unwrap();
        }
        assert!(model.revoked("root", "grant:plan"));
        model.apply(&reviewed).unwrap();
        plan["payload"]["authorities"][0]["authorityId"] = json!("grant:late-plan");
        assert_eq!(
            model.apply(&plan).unwrap_err().code,
            "plan_delegation_missing"
        );
    }

    #[test]
    fn tightening_revokes_automatic_plan_grants_and_rejects_new_automatic_confirmations() {
        let mut model = KernelPermissionModel::default();
        let broad = json!({"agent.permissions.workspaceMutation":"allow"});
        create(&mut model, "parent", None, broad.clone());
        create(&mut model, "child", Some("parent"), broad);
        let plan = json!({"type":"plan.confirmed", "sessionId":"child", "payload":{"source":"agent",
            "authorities":[{"authorityId":"plan:automatic", "sessionId":"child"}]}});
        model.apply(&plan).unwrap();
        assert!(!model.revoked("child", "plan:automatic"));
        model
            .apply(
                &json!({"type":"session.permissions.updated", "sessionId":"parent",
            "payload":{"patches":{"agent.permissions.workspaceMutation":"plan"}}}),
            )
            .unwrap();
        assert!(model.revoked("child", "plan:automatic"));
        assert_eq!(
            model.apply(&plan).unwrap_err().code,
            "plan_delegation_missing"
        );
        let mut user_plan = plan.clone();
        user_plan["payload"]["source"] = json!("user");
        user_plan["payload"]["authorities"][0]["authorityId"] = json!("plan:user");
        model.apply(&user_plan).unwrap();
        assert!(!model.revoked("child", "plan:user"));
        let mut orphaned_archive = KernelPermissionModel::default();
        create(
            &mut orphaned_archive,
            "child",
            Some("deleted-parent"),
            json!({
            "agent.permissions.workspaceMutation":"allow"}),
        );
        // Historical automatic confirmations are not re-admitted on restore.
        orphaned_archive.restore(&plan).unwrap();
        assert!(orphaned_archive.revoked("child", "plan:automatic"));
    }

    #[test]
    fn tightening_propagates_rules_read_roots_and_revokes_old_child_approvals() {
        let mut model = KernelPermissionModel::default();
        let context =
            json!({"command":"git status", "workspaceId":"workspace:test", "environment":{}});
        let broad = json!({"agent.permissions.shell":"allow", "agent.permissions.shellAccess":"full",
            "agent.permissions.commandDenylist":[], "agent.permissions.runtimeReadRoots":["/tools","/sdk"]});
        create(&mut model, "parent", None, broad.clone());
        let mut local = broad.clone();
        local["agent.permissions.commandDenylist"] = json!(["git reset --hard"]);
        local["agent.permissions.external"] = json!("deny");
        local["agent.permissions.commandRules"] =
            json!(serde_json::to_string(&json!([{"context":context,"decision":"allow"}])).unwrap());
        create(&mut model, "child", Some("parent"), local);
        model
            .apply(&json!({"type":"approval.resolved","sessionId":"child",
            "payload":{"authorityId":"grant:old","decision":"allow"}}))
            .unwrap();
        let snapshot = model.effective("child").unwrap();
        assert!(!model.revoked("child", "grant:old"));
        model.apply(&json!({"type":"session.permissions.updated","sessionId":"parent","payload":{"patches":{
            "agent.permissions.shell":"ask", "agent.permissions.commandDenylist":["git clean"],
            "agent.permissions.runtimeReadRoots":["/tools"]}}})).unwrap();
        let settings = &model.effective("child").unwrap().settings;
        assert_eq!(
            settings["agent.permissions.runtimeReadRoots"],
            json!(["/tools"])
        );
        assert_eq!(
            settings["agent.permissions.commandDenylist"],
            json!(["git reset --hard", "git clean"])
        );
        assert_eq!(settings["agent.permissions.external"], "deny");
        let rules: Value =
            serde_json::from_str(settings["agent.permissions.commandRules"].as_str().unwrap())
                .unwrap();
        assert_eq!(rules[0]["decision"], "ask");
        assert!(model.revoked("child", "grant:old"));
        assert_eq!(snapshot.settings["agent.permissions.shell"], "allow");
        model
            .apply(&json!({"type":"approval.resolved","sessionId":"child",
            "payload":{"authorityId":"grant:new","decision":"allow"}}))
            .unwrap();
        assert!(!model.revoked("child", "grant:new"));
        model.remove("parent").unwrap();
        assert_eq!(
            model.effective("child").unwrap().settings["agent.permissions.networkRead"],
            "deny"
        );
        assert!(model.revoked("child", "grant:new"));
    }
}
