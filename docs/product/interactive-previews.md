# Interactive component previews

An inline preview can place a self-contained component, interactive explanation or design review between paragraphs of a reply. The sidebar can give the same artifact more room. The embedded browser supports complete applications, development servers and multi-page flows. Choose the presentation that fits the task; Frontend Design describes the options.

## Inline reference

An `achbit-preview` fence renders an archived HTML artifact interactively. Use the actual artifact URI returned by the existing archive and delivery tools:

````markdown
Here is the component:

```achbit-preview
artifact://<the returned artifact ID>
```

Continue the explanation here.
````

The preview block contains the reference; the artifact holds the HTML. File-backed output links open the corresponding file in the file sidebar, while an ordinary HTML code fence displays source.

## Content and versions

Self-contained HTML with embedded CSS, JavaScript and assets can run directly in the isolated preview frame. Compiled components and relative resources can be bundled with the project's existing build tools. The frame provides page interaction, with Achbit Host operations remaining in their existing tools.

`artifact.prepare` archives an existing file and `artifact.present` registers its delivery. A renderer that already returns an artifact ID supplies the archive step itself. Prepare changed content as a new version and present that version; earlier inline-preview references retain their original bytes.

Conversation previews are horizontally centered in the available pane. In the sidebar Reader, components are centered on both axes and viewport-filling apps use the full preview area. A component keeps its natural size when it fits. Wider content can use spare pane space; when constrained it reflows first, and a fixed-width component scales down only when its minimum width cannot fit. Tall flow content scrolls rather than shrinking all its text. Viewport-filling apps reflow at the available pane width without reloading. Click or tap the preview, or focus its card with Tab, to reveal More preview actions (source, save image and reload) and Open in sidebar. The controls hide when focus leaves the card. Each placement owns temporary interaction state; the four most recently used preview rows stay mounted while scrolling in the current conversation. Returning to a cached conversation resumes its mounted previews. Reopening a released view starts the archived version again. Preview interactions are local to the view, separate from model calls and Session history.
