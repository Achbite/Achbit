//! Read-only product contributions. Session remains the journal/reducer owner;
//! these executors only adapt registered tool calls to its query port.
use crate::session_service::{SessionServiceError, SessionServiceProcess};
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) trait SessionReadPort: Send + Sync {
    fn read(&self, query: Value) -> Result<Value, SessionServiceError>;
}

impl SessionReadPort for SessionServiceProcess {
    fn read(&self, query: Value) -> Result<Value, SessionServiceError> {
        self.request("read", query)
    }
}

pub(crate) struct ProductTools {
    reader: Arc<dyn SessionReadPort>,
    resources: Option<crate::local_agent_resources::SessionResources>,
    plugin_settings: Value,
    is_child_agent: bool,
    pub(crate) browser_binding: Option<Value>,
    pub(crate) desktop: Option<crate::desktop_tools::DesktopRun>,
    pub(crate) computer_use_instance: Option<String>,
    pub(crate) container_instance: Option<String>,
    pub(crate) container_runtime: Option<Arc<crate::container_tools::Containers>>,
    pub(crate) document_instance: Option<String>,
    pub(crate) diagnostics: Option<(String, String)>,
}

impl ProductTools {
    pub(crate) fn new(reader: Arc<dyn SessionReadPort>) -> Self {
        Self {
            reader,
            resources: None,
            plugin_settings: json!({}),
            is_child_agent: false,
            browser_binding: None,
            desktop: None,
            computer_use_instance: None,
            container_instance: None,
            container_runtime: None,
            document_instance: None,
            diagnostics: None,
        }
    }

    pub(crate) fn with_plugin_settings(mut self, settings: Value, is_child_agent: bool) -> Self {
        self.plugin_settings = settings;
        self.is_child_agent = is_child_agent;
        self
    }

    pub(crate) fn with_resources(
        mut self,
        resources: crate::local_agent_resources::SessionResources,
    ) -> Self {
        self.resources = Some(resources);
        self
    }

    pub(crate) fn with_computer_use(mut self, instance: Option<String>) -> Self {
        self.computer_use_instance = instance;
        self
    }
    pub(crate) fn with_documents(mut self, instance: Option<String>) -> Self {
        self.document_instance = instance;
        self
    }

    pub(crate) fn with_session_diagnostics(
        mut self,
        session_id: &str,
        instance: Option<String>,
    ) -> Self {
        self.diagnostics = instance.map(|instance| (session_id.to_owned(), instance));
        self
    }

    pub(crate) fn with_containers(mut self, instance: Option<String>) -> Self {
        self.container_instance = instance;
        self
    }

    pub(crate) fn with_container_runtime(
        mut self,
        runtime: Option<Arc<crate::container_tools::Containers>>,
    ) -> Self {
        self.container_runtime = runtime;
        self
    }

    pub(crate) fn with_desktop(mut self, desktop: crate::desktop_tools::DesktopRun) -> Self {
        self.desktop = Some(desktop);
        self
    }

    pub(crate) fn with_browser_binding(mut self, binding: Option<Value>) -> Self {
        self.browser_binding = binding;
        self
    }

    pub(crate) fn call(&self, name: &str, input: Value) -> Result<Value, SessionServiceError> {
        match name {
            "session.diagnostics" => {
                let (session_id, _) = self.diagnostics.as_ref().ok_or_else(|| {
                    SessionServiceError::new(
                        "session_diagnostics_inactive",
                        "The Session Diagnostics component is not active.",
                    )
                })?;
                let mut query = input;
                let fields = query.as_object_mut().ok_or_else(|| {
                    SessionServiceError::new(
                        "session_diagnostics_input_invalid",
                        "Session Diagnostics requires an object.",
                    )
                })?;
                if fields
                    .insert("sessionId".into(), json!(session_id))
                    .is_some()
                {
                    return Err(SessionServiceError::new(
                        "session_diagnostics_target_invalid",
                        "This component is bound to the current session.",
                    ));
                }
                self.reader.read(query)
            }
            "session.read" if input["view"] == "resources" => self
                .resources
                .as_ref()
                .ok_or_else(|| {
                    SessionServiceError::new(
                        "agent_resources_unavailable",
                        "Agent resource reader is not installed.",
                    )
                })?
                .read(input),
            "session.read" => self.reader.read(input),
            "skill.read" => read_skill(input),
            "plugin.search" => {
                let query = input["query"].as_str().unwrap_or("");
                let limit = input["limit"].as_u64().unwrap_or(20) as usize;
                let offset = input["offset"].as_u64().unwrap_or(0) as usize;
                crate::local_agent_plugins::search_plugins(
                    &self.plugin_settings,
                    query,
                    limit,
                    offset,
                    self.is_child_agent,
                )
                .map_err(|message| SessionServiceError::new("plugin_catalog_unavailable", message))
            }
            _ => Err(SessionServiceError::new("tool_not_found", name)),
        }
    }

    pub(crate) fn definitions() -> Vec<(&'static str, String, Value)> {
        vec![
            ("plugin.search", "Discover enabled tools and Skills by capability. Use a short product or capability query; all whitespace-separated keywords match case-insensitively against a plugin's name, URI or description. Omit query to browse. total counts all matches and nextOffset continues the same query. A zero-match query can be shortened or omitted. Discovery returns references; activation loads the selected tools or Skill entry for the next request. User mentions are optional. For standalone documents use Documents; for frontend pages or interactive previews use Frontend Design and read its Skill. Host-managed service and display plugin status is available through the product CLI.".into(), json!({
                "type":"object", "additionalProperties":false, "properties":{
                    "query":{"type":"string","maxLength":240,"description":"Short literal keywords; all must match. Omit to browse the catalog."},
                    "limit":{"type":"integer","minimum":1,"description":"Page size; defaults to 20. More results remain accessible through nextOffset."},
                    "offset":{"type":"integer","minimum":0,"description":"Use nextOffset from the previous result with the same query; defaults to 0."}
                }
            })),
            ("session.read", "Read the specified conversation history. Start with summary, then read the relevant messages, tools or plans. Use nextBefore for older entries and nextOffset for longer fields.".into(), session_read_schema()),
            ("skill.read", "Read a named bundled Skill or a reference within it. Omit path to read SKILL.md.".into(), json!({
                "type":"object", "additionalProperties":false, "required":["name"],
                "properties": {
                    "name":{"type":"string","enum": SKILLS.iter().map(|skill| skill.id).collect::<Vec<_>>()},
                    "path":{"type":"string","description":"SKILL.md or a reference path linked by that Skill."}
                }
            })),

        ]
    }
}

fn session_read_schema() -> Value {
    json!({
        "type":"object", "additionalProperties":false, "required":["sessionId"],
        "properties": {
            "sessionId":{"type":"string","description":"Exact complete ID from the user or Achbit. Preserve it verbatim, including prefixes such as session:."},
            "view":{"type":"string","enum":["summary","messages","tools","plans","context","reasoning","images","resources"]},
            "resource":{"type":"object","additionalProperties":false,"required":["workspaceId","logicalPath"],"properties":{
                "workspaceId":{"type":"string"},"logicalPath":{"type":"string"}},
                "description":"Requires view=resources. Use an exact reference returned by the resource listing; never a caller workspace selector. Omit to list managed workdirs; a directory lists entries and a file reads text."},
            "startLine":{"type":"integer","minimum":1},
            "startByte":{"type":"integer","minimum":0},
            "imageIds":{"type":"array","uniqueItems":true,"items":{"type":"string","minLength":1},"description":"Requires view=images. Exact current-session image references to inspect together. Select only images needed for the current comparison. Omit to list references; [] releases pixels. Do not combine with before or limit."},
            "before":{"type":"integer","minimum":1},
            "throughSequence":{"type":"integer","minimum":1,"description":"Inclusive history snapshot boundary, independent of the page cursor."},
            "limit":{"type":"integer","minimum":1,"maximum":50},
            "recordId":{"type":"string","description":"Exact ToolRecord ID; requires view=tools. Input/output/error return separately bounded chunks; continue each field using its nextOffset."},
            "messageId":{"type":"string","description":"Exact committed message ID returned by view=messages; returns a bounded content chunk. Continue with its nextOffset."},
            "providerRequestId":{"type":"string","description":"Exact Provider request ID; requires view=context or reasoning."},
            "offset":{"type":"integer","minimum":0,"description":"UTF-16 character cursor. Use nextOffset from reasoning, an exact messageId (view=messages), or a field of an exact recordId (view=tools). Fields return independent actual offset/nextOffset and totalCharacters/totalBytes; null nextOffset means that field is complete."}
        }
    })
}

pub(crate) fn session_diagnostics_schema() -> Value {
    let mut schema = session_read_schema();
    schema["required"] = json!([]);
    let fields = schema["properties"]
        .as_object_mut()
        .expect("session read properties");
    fields.retain(|name, _| {
        matches!(
            name.as_str(),
            "view" | "before" | "limit" | "recordId" | "messageId" | "providerRequestId" | "offset"
        )
    });
    fields.insert("view".into(), json!({"type":"string","enum":["summary","messages","tools","plans","context","reasoning"]}));
    schema
}

struct ProductSkill {
    id: &'static str,
    entry: &'static str,
    references: &'static [(&'static str, &'static str)],
}

impl ProductSkill {
    fn description(&self) -> &str {
        self.entry
            .lines()
            .find_map(|line| line.strip_prefix("description: "))
            .expect("bundled Skill has a description")
    }
}

const SKILLS: &[ProductSkill] = &[
    ProductSkill {
        id: "achbit-session",
        entry: include_str!("../../../skills/achbit-session/SKILL.md"),
        references: &[(
            "references/session-query.md",
            include_str!("../../../skills/achbit-session/references/session-query.md"),
        )],
    },
    ProductSkill {
        id: "achbit-product",
        entry: include_str!("../../../skills/achbit-product/SKILL.md"),
        references: &[
            (
                "references/operations.md",
                include_str!("../../../skills/achbit-product/references/operations.md"),
            ),
            (
                "references/windows-environment.md",
                include_str!("../../../skills/achbit-product/references/windows-environment.md"),
            ),
        ],
    },
    ProductSkill {
        id: "achbit-iteration",
        entry: include_str!("../../../skills/achbit-iteration/SKILL.md"),
        references: &[
            (
                "references/implementation-map.md",
                include_str!("../../../skills/achbit-iteration/references/implementation-map.md"),
            ),
            (
                "references/update-modes.md",
                include_str!("../../../skills/achbit-iteration/references/update-modes.md"),
            ),
            (
                "references/plugin-development.md",
                include_str!("../../../skills/achbit-iteration/references/plugin-development.md"),
            ),
        ],
    },
    ProductSkill {
        id: "achbit-release-audit",
        entry: include_str!("../../../skills/achbit-release-audit/SKILL.md"),
        references: &[
            (
                "references/simplification.md",
                include_str!("../../../skills/achbit-release-audit/references/simplification.md"),
            ),
            (
                "references/product-docs.md",
                include_str!("../../../skills/achbit-release-audit/references/product-docs.md"),
            ),
        ],
    },
    ProductSkill {
        id: "achbit-documents",
        entry: include_str!("../../../skills/achbit-documents/SKILL.md"),
        references: &[
            (
                "references/design.md",
                include_str!("../../../skills/achbit-documents/references/design.md"),
            ),
            (
                "references/inline-diagrams.md",
                include_str!("../../../skills/achbit-documents/references/inline-diagrams.md"),
            ),
            (
                "references/formats.md",
                include_str!("../../../skills/achbit-documents/references/formats.md"),
            ),
            (
                "references/interactive-previews.md",
                include_str!("../../../skills/achbit-documents/references/interactive-previews.md"),
            ),
            (
                "assets/document.html",
                include_str!("../../../skills/achbit-documents/assets/document.html"),
            ),
            (
                "assets/document.typ",
                include_str!("../../../skills/achbit-documents/assets/document.typ"),
            ),
            (
                "THIRD_PARTY_NOTICES.md",
                include_str!("../../../skills/achbit-documents/THIRD_PARTY_NOTICES.md"),
            ),
        ],
    },
];

pub(crate) fn bundled_skill_settings() -> Vec<Value> {
    SKILLS
        .iter()
        .map(|skill| {
            json!({
                "id": skill.id,
                "displayName": if skill.id == "achbit-documents" { "文档排版" } else { skill.id },
                "description": if skill.id == "achbit-documents" { "排版并导出 HTML、PDF 和 Markdown。" } else { skill.description() },
                "source": "builtin",
            })
        })
        .collect()
}

fn read_skill(input: Value) -> Result<Value, SessionServiceError> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Query {
        name: String,
        path: Option<String>,
    }
    if input.get("path").is_some_and(|path| !path.is_string()) {
        return Err(SessionServiceError::new(
            "tool_input_invalid",
            "path must be a string",
        ));
    }
    let query: Query = serde_json::from_value(input)
        .map_err(|error| SessionServiceError::new("tool_input_invalid", error.to_string()))?;
    let skill = SKILLS
        .iter()
        .find(|skill| skill.id == query.name)
        .ok_or_else(|| SessionServiceError::new("skill_not_found", &query.name))?;
    let path = query.path.as_deref().unwrap_or("SKILL.md");
    let content = if path == "SKILL.md" {
        skill.entry
    } else {
        skill
            .references
            .iter()
            .find(|(candidate, _)| *candidate == path)
            .map(|(_, content)| *content)
            .ok_or_else(|| SessionServiceError::new("skill_resource_not_found", path))?
    };
    Ok(json!({"name":skill.id,"path":path,"content":content}))
}

#[cfg(test)]
pub(crate) fn test_product_tools() -> Arc<ProductTools> {
    struct Reader;
    impl SessionReadPort for Reader {
        fn read(&self, _: Value) -> Result<Value, SessionServiceError> {
            Err(SessionServiceError::new(
                "session_not_found",
                "No session in this isolated fixture.",
            ))
        }
    }
    Arc::new(ProductTools::new(Arc::new(Reader)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_uses_its_selected_session_while_history_uses_the_supplied_id() {
        struct Echo;
        impl SessionReadPort for Echo {
            fn read(&self, query: Value) -> Result<Value, SessionServiceError> {
                Ok(query)
            }
        }
        let tools = ProductTools::new(Arc::new(Echo));
        assert_eq!(
            tools
                .call("session.diagnostics", json!({"view":"context"}))
                .unwrap_err()
                .code,
            "session_diagnostics_inactive"
        );
        let tools = tools.with_session_diagnostics("session:current", Some("instance:test".into()));
        assert_eq!(
            tools
                .call("session.diagnostics", json!({"view":"context"}))
                .unwrap(),
            json!({"view":"context","sessionId":"session:current"})
        );
        assert_eq!(
            tools
                .call("session.diagnostics", json!({"sessionId":"session:other"}))
                .unwrap_err()
                .code,
            "session_diagnostics_target_invalid"
        );
        assert_eq!(
            tools
                .call(
                    "session.read",
                    json!({"sessionId":"session:historical","view":"context"})
                )
                .unwrap()["sessionId"],
            "session:historical"
        );
    }

    #[test]
    fn product_documentation_does_not_add_tool_or_plugin_entries() {
        let tools = test_product_tools();
        assert!(ProductTools::definitions()
            .iter()
            .all(|(name, _, _)| !name.starts_with("doc.")));
        let catalog = crate::local_agent_plugins::plugin_catalog_projection(&json!({})).unwrap();
        assert!(catalog["plugins"].as_array().unwrap().iter().all(|plugin| {
            plugin["reference"]["toolName"] != "doc.read"
                && !plugin["uri"].as_str().unwrap().starts_with("plugin://doc-")
        }));
        for name in ["doc.search", "doc.read"] {
            assert_eq!(
                tools.call(name, json!({})).unwrap_err().code,
                "tool_not_found"
            );
        }
    }

    #[test]
    fn plugin_search_discovers_capabilities_without_loading_tools() {
        let tools = test_product_tools();
        let found = tools
            .call("plugin.search", json!({"query":"browser"}))
            .unwrap();
        assert!(found["plugins"].as_array().unwrap().iter().any(|plugin| {
            plugin["uri"] == "plugin://computer-use@builtin"
                && plugin.as_object().unwrap().len() == 3
        }));
        let first = tools.call("plugin.search", json!({"limit":1})).unwrap();
        assert_eq!(first["plugins"].as_array().unwrap().len(), 1);
        assert_eq!(first["nextOffset"], 1);
        let second = tools
            .call(
                "plugin.search",
                json!({"limit":1,"offset":first["nextOffset"]}),
            )
            .unwrap();
        assert_eq!(second["total"], first["total"]);
        assert_ne!(second["plugins"][0]["uri"], first["plugins"][0]["uri"]);
        assert!(tools.computer_use_instance.is_none());
    }

    #[test]
    fn child_plugin_search_excludes_only_the_forbidden_computer_plugin() {
        let settings = json!({"mcp.servers":serde_json::to_string(&json!([{
            "id":"lab", "name":"Lab bridge", "description":"Read lab instruments.",
            "command":"python3", "args":""
        }])).unwrap()});
        let main = Arc::try_unwrap(test_product_tools())
            .ok()
            .unwrap()
            .with_plugin_settings(settings.clone(), false);
        let child = Arc::try_unwrap(test_product_tools())
            .ok()
            .unwrap()
            .with_plugin_settings(settings.clone(), true);
        let query = json!({"limit":1000});
        let main_results = main.call("plugin.search", query.clone()).unwrap();
        let child_results = child.call("plugin.search", query).unwrap();
        let main_plugins = main_results["plugins"].as_array().unwrap();
        let child_plugins = child_results["plugins"].as_array().unwrap();
        let computer = "plugin://computer-use@builtin";
        assert!(main_plugins.iter().any(|plugin| plugin["uri"] == computer));
        assert_eq!(
            child_plugins,
            &main_plugins
                .iter()
                .filter(|plugin| plugin["uri"] != computer)
                .cloned()
                .collect::<Vec<_>>()
        );
        for uri in [
            "plugin://documents@builtin",
            "plugin://containers@builtin",
            "plugin://lab@mcp",
        ] {
            assert!(
                child_plugins.iter().any(|plugin| plugin["uri"] == uri),
                "{uri}"
            );
            assert!(crate::local_agent_plugins::plugin_allowed_for_session(
                uri, true
            ));
        }
        assert!(!crate::local_agent_plugins::plugin_allowed_for_session(
            computer, true
        ));
        assert!(crate::local_agent_plugins::plugin_allowed_for_session(
            computer, false
        ));
        assert_eq!(
            child_results["total"].as_u64().unwrap() as usize,
            child_plugins.len()
        );
        let first = child.call("plugin.search", json!({"limit":1})).unwrap();
        assert_eq!(first["total"], child_results["total"]);
        assert_eq!(first["nextOffset"], 1);
        let catalog = crate::local_agent_plugins::plugin_catalog_projection(&settings).unwrap();
        assert!(catalog["plugins"]
            .as_array()
            .unwrap()
            .iter()
            .any(|plugin| plugin["uri"] == computer && plugin["available"] == true));
    }

    #[test]
    fn product_skills_keep_their_read_only_resources() {
        let tools = test_product_tools();
        assert!(tools
            .call("skill.read", json!({"name":"execution-environments.md"}))
            .is_err());
        let skill = tools
            .call("skill.read", json!({"name":"achbit-product"}))
            .unwrap();
        assert!(skill["content"]
            .as_str()
            .unwrap()
            .starts_with("---\nname: achbit-product"));
        for path in [
            "SKILL.md",
            "references/design.md",
            "references/inline-diagrams.md",
            "references/formats.md",
            "references/interactive-previews.md",
            "assets/document.html",
            "assets/document.typ",
        ] {
            let resource = tools
                .call(
                    "skill.read",
                    json!({"name":"achbit-documents", "path":path}),
                )
                .unwrap();
            assert_eq!(resource["path"], path);
            assert!(!resource["content"].as_str().unwrap().is_empty());
        }
    }

    #[test]
    fn development_skills_are_discoverable_read_only_references() {
        let tools = test_product_tools();
        let definitions = ProductTools::definitions();
        let (_, _, schema) = definitions
            .iter()
            .find(|(name, _, _)| *name == "skill.read")
            .unwrap();
        let names = schema["properties"]["name"]["enum"].as_array().unwrap();
        let catalog = crate::local_agent_plugins::plugin_catalog_projection(&json!({})).unwrap();
        for (name, references) in [
            (
                "achbit-iteration",
                [
                    "references/implementation-map.md",
                    "references/update-modes.md",
                ],
            ),
            (
                "achbit-release-audit",
                ["references/simplification.md", "references/product-docs.md"],
            ),
        ] {
            assert!(names.contains(&json!(name)));
            let uri = format!("plugin://{name}@builtin");
            let entry = catalog["plugins"]
                .as_array()
                .unwrap()
                .iter()
                .find(|plugin| plugin["uri"] == uri)
                .unwrap();
            assert_eq!(entry["source"], "builtin");
            assert_eq!(entry["contributionKind"], "skill");
            assert_eq!(entry["category"], "reference");
            assert_eq!(entry["discovery"], "searchOnly");
            assert_eq!(entry["enabled"], true);
            assert_eq!(entry["available"], true);
            assert_eq!(
                entry["reference"],
                json!({"toolName":"skill.read", "name":name})
            );
            let skill = tools.call("skill.read", json!({"name":name})).unwrap();
            assert_eq!(skill["name"], name);
            assert_eq!(skill["path"], "SKILL.md");
            assert!(!skill["content"].as_str().unwrap().is_empty());
            for path in references {
                let resource = tools
                    .call("skill.read", json!({"name":name, "path":path}))
                    .unwrap();
                assert_eq!(resource["path"], path);
                assert!(!resource["content"].as_str().unwrap().is_empty());
            }
        }
        assert!(tools.computer_use_instance.is_none());
        assert!(tools.container_instance.is_none());
        assert!(tools.document_instance.is_none());
    }
}
