# DeepSeek API: from browser research to a working checklist

[All examples](../README.md)

Use DeepSeek and Achbit's Computer Use plugin to read public documentation and create an interactive checklist. This example includes a self-contained reference page and a prompt for creating your own version.

![Checklist interface preview](report-checked.png)

## Open the example

- Download [report.html](report.html) and open it in a browser. It is a self-contained Chinese reference page with 18 checklist items in five groups, progress counters, and local persistence.
- [sources.json](sources.json) maps the report's claims to the original documentation and its lookup date.
- [report-checked.png](report-checked.png) previews the checklist interface.

Selections and notes stay in your browser. Use the reset button to clear them. The checkboxes record selections; they do not execute browser compatibility tests.

## Create your own version

Configure a DeepSeek API connection using the [setup guide](../../docs/product/deepseek.md), open an output directory as a project in Achbit and paste the [task prompt](prompt.zh-CN.txt) into a new GUI conversation. Keep the built-in Computer Use plugin available. The task needs public network access and permission to write its output files.

The prompt asks for a Chinese reference page, source links, interactive progress and local persistence. It also asks the agent to open the result in the built-in browser and inspect its interactions.

## Sources

Documentation excerpts and translated summaries are attributed to Microsoft and Playwright contributors, [Browsers](https://playwright.dev/docs/browsers), under [CC BY 4.0](https://github.com/microsoft/playwright.dev/blob/main/LICENSE). The example provides a Chinese adaptation with a checklist layout and local interactions. Consult the current source documentation when applying its browser-support information. No endorsement by Playwright is implied.
