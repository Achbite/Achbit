# Interactive component previews

Use an inline preview for a small frontend component, interactive explanation or design review that belongs between paragraphs of the reply. Use the existing sidebar browser for complete applications, development servers and multi-page sites.

Create a self-contained HTML file in the task workspace, with its CSS, JavaScript and assets embedded. HTML/CSS/JavaScript runs in an isolated frame; it has no Achbit Host APIs. For React or other compiled components, use the project's existing build tools to bundle the preview first. Relative assets and imports need bundling; do not require a new preview server for a component.

Archive the finished file with `artifact.prepare`, deliver it with `artifact.present`, and place its returned artifact URI alone in an `achbit-preview` fence at the intended position:

````markdown
Here is the component:

```achbit-preview
artifact://<the returned artifact ID>
```

Continue the explanation here.
````

Copy the real returned URI; never invent an ID. Ordinary HTML code fences show source, and ordinary artifact links open the document reader. Only an explicit preview fence renders an archived HTML artifact interactively.

The GUI exposes source, reload and open-in-sidebar controls. Each placement owns temporary interaction state; the four most recently used preview rows stay mounted while scrolling in the current conversation. Reopening a released view starts the archived version again. Updating a file requires preparing and presenting a new artifact version; an earlier reply retains its original version.

Keep the reply's preview block to the reference, rather than repeating the full HTML. GUI interactions do not call the model or rewrite Session history. Read this guide on demand; do not insert generated preview content into system instructions or change tool declarations for each preview.
