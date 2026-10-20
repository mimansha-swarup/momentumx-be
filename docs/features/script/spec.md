# Script

Script turns a project idea into a draft the creator can review and edit. Each project keeps its own script, even when several projects use the same idea.

## Creator flow

1. Open a project and request a script.
2. Read the text as it arrives. Successful generation saves the script and completes this step.
3. Review and edit the text, regenerate it, or export it.
4. Continue to Hooks, then Title and Packaging.

Opening an existing script returns saved work rather than generating a replacement. Regeneration replaces the existing text; there is no version-history interface. Changing script text can make existing hooks, title and packaging need review. A title-only rename does not rewrite the script.

## Scope and limits

The result is a draft for creator review, not a guarantee of accuracy, retention or video length. Generation can fail or stop before saving; the client must show the reported error rather than treating a closed stream as success. Manual editing and full regeneration are available; directional AI editing is future work.

Editors and owners can generate and edit; viewers can read and export. See the [API reference](./api.md) for streaming and request details, and the [pipeline model](../../product/pipeline-spec.md) for review state. Local implementation does not establish provider quality or production release.
