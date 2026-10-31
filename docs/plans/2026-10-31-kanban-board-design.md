# Kanban board: design

Status: design, not implemented. Replaces the single notes list with a project-based
Kanban board. Terms used here (the pipeline, the four gates, the additive-only rule,
`prod-good`, the smoke convention) are defined in `CLAUDE.md`.

## Problem and goals

The app exists to give the pipeline something real to gate. Today it is one form and one
list: about 70 lines of UI, three API routes and one table. Changes that small never
exercise the gates on the work real teams ship: a multi-entity data model, a second
table and its IAM grant, a UI dependency upgrade, interaction-heavy E2E tests, and a
staged rollout that has to stay safe to roll back. The site is also now owner-only, so
the owner can use it as a real board.

Goals:

- a sidebar listing projects;
- a board per project with columns the owner defines;
- cards with a title, a description and labels;
- drag and drop for cards and columns, with the mouse and the keyboard;
- a cleaner look, with light and dark themes;
- every step ships through the four gates and stays safe to roll back.

Non-goals: multiple users or sharing, comments, due dates, attachments, search, card
history, reordering projects, offline use, sidebar card counts.

## Decisions

| Topic | Decision |
|---|---|
| Card lifetime | Projects, columns, labels and cards do not expire, with two exceptions: a card in a project's done column expires 7 days after entering it, and everything in a smoke project expires 1 hour after the project was created. |
| Columns | Custom per project. Each project gets a done column when it is created; it can be renamed and moved but not deleted, and the done marker cannot move to another column. |
| Drag and drop | Cards (within and between columns) and columns (reorder). Projects are listed by creation time. Keyboard dragging included. |
| Card content | Title, optional description, labels. |
| Existing notes | Not migrated. They expire on their own; the notes code is removed in the cleanup step. |
| UI stack | Tailwind CSS v4 plus shadcn/ui components, `@dnd-kit` for drag and drop. |

## Alternatives considered

| Choice | Alternative | Why not |
|---|---|---|
| New `Board` table | Add a sort key to `Notes` | Changing a key schema replaces the table, which breaks the additive-only rule and loses data on rollback. |
| One `Board` table, one partition per project | A table per entity (projects, columns, cards, labels) | Four tables, four grants, and a board load becomes four queries. One partition loads a board in one query. |
| Fractional-index ranks | Integer positions, or an ordered ID list on each column | Integers mean rewriting every item after the drop point; an ID list means two items change on every cross-column move and can drift from the cards. A rank writes only the moved card. |
| `@dnd-kit` | Native HTML5 drag and drop | No keyboard or touch support, and Playwright handles native drag poorly. |
| Tailwind plus shadcn/ui | Hand-written CSS with design tokens | Hand-written CSS adds no dependencies, but the owner chose the faster polished result. The supply-chain cost is handled by listing and pinning every package (see Dependencies). |
| Done-card expiry with a fixed done column | Keep every card; or let any column be marked done | Keeping everything lets the board fill with finished work. A movable done marker means rewriting up to 1000 cards and a race between card moves and the switch. |
| Leave old notes to expire | Migrate notes into an "Inbox" project | A migration needs its own deploy step and tests, for notes that expire within 7 days anyway. |
| Smoke status set when the project is created | Re-derive it from the name on every write | Renaming would change expiry: a real project renamed to `smoke-x` would be deleted within an hour, and a smoke card could lose its expiry. |

## Architecture

The request path does not change. CloudFront, the owner-only edge function, the
origin-verify check and API Gateway throttling (10 rps, burst 20) stay as they are. Only
the Lambda and the SPA change.

- **API.** `createHandler` replaces its if-chain with a small route table (method, path
  pattern, handler). Shared helpers stay shared: `json`, `readBody`, `sameSecret`, and
  the injected `now` and `newId`. Board code follows the existing `notes.ts` split:
  - `board.ts`: input parsing and the domain rules (expiry, caps, done column);
  - `board-repo.ts`: a `BoardRepo` interface and its DynamoDB implementation, next to
    `NotesRepo`.

  `HandlerDeps` takes both repos, and `lambda.ts` reads both table names from the
  environment. `local-server.ts` creates the `Board` table in DynamoDB Local for dev and
  E2E.
- **SPA.** One board state per open project, loaded by `GET /board`. Edits update that
  state first, then call the API; on failure the SPA undoes the change, shows a toast,
  and reloads the board. The theme choice is saved in `localStorage`. The label filter
  runs on the loaded board, in the browser.

## Layout and look

- **Shell:** a fixed left sidebar and the board filling the rest.
  - The sidebar shows the app name, the projects (oldest first) with the active one
    marked, a "New project" button, and a light/dark/system theme toggle.
  - On narrow screens the sidebar becomes a sheet opened from a menu button.
- **Look:** neutral greys, one accent color, the system font stack, small rounded
  corners, 1px borders rather than shadows. Dark mode uses shadcn's CSS variables.
- **Board header:** the project name (click to rename), a label filter, and a menu with
  rename, delete and "Manage labels".
- **Columns:** fixed width; the board scrolls sideways when they do not fit.
  - Each column header shows its name and a menu: rename, delete. The done column shows
    a check mark instead of a delete option.
  - "Add card" at the bottom of each column opens an inline input.
  - "Add column" is the last item on the right.
- **Cards:** title, label chips, and an icon when there is a description. Cards in the
  done column show "expires in N days".
  - Clicking a card opens a side panel to edit the title, description and labels, or
    delete the card.
- **Drag and drop:** the dragged item is raised with a shadow and a line marks the drop
  position. Columns are dragged by their header. The keyboard can pick up, move, drop
  and cancel.
- **New projects** start with three columns: To do, Doing and Done (the done column).
  With no projects, the board area shows one "Create your first project" button.

## Data

New `Board` table: keys `pk` and `sk` (strings), on-demand billing, TTL on `expiresAt`,
and the same removal policy and point-in-time recovery settings as `Notes`. The Lambda
role gets read and write access to `Notes` and `Board`, nothing else.

| Item | pk | sk | Fields |
|---|---|---|---|
| Project | `PROJECTS` | `<projectId>` | name (1-80), createdAt, isSmoke, expiresAt (smoke only) |
| Column | `PROJECT#<projectId>` | `COLUMN#<columnId>` | name (1-40), rank, isDone, expiresAt (smoke only) |
| Card | `PROJECT#<projectId>` | `CARD#<cardId>` | columnId, rank, title (1-200), description (0-2000), labelIds (0-30, unique), doneAt, expiresAt |
| Label | `PROJECT#<projectId>` | `LABEL#<labelId>` | name (1-30), color, expiresAt (smoke only) |

- Lengths are in Unicode code points, after trimming. IDs are server-generated UUIDs.
- `color` is one of 8 fixed palette names, never a raw CSS value.
- The sidebar is one query on `pk = PROJECTS`, sorted by `createdAt` in the API. A board
  is one query on `pk = PROJECT#<projectId>`; the repo follows `LastEvaluatedKey` across
  pages, as `NotesRepo.list` already does. All projects share one partition; at 50
  projects that is a deliberate limit, not a hot spot.

### Ordering

Cards and columns carry a `rank` string from fractional indexing (the
`fractional-indexing` package). To move an item, the client computes a rank between its
new neighbours and sends it. The server accepts ranks of 1-64 characters from the
package's alphabet and rejects anything else with 400. Equal ranks sort by ID. A move
writes only the moved item.

If the client cannot compute a valid rank (neighbours with equal ranks, or a rank over
64 characters), the move fails like any other failed save: undo, toast, reload. At one
user this needs hundreds of drops into the same gap, so no rebalancing is built.

### Expiry

The server sets expiry; the client never sends `expiresAt` or `doneAt`.

- **Normal projects:** a card that enters the done column gets `doneAt = now` and
  `expiresAt = now + 7 days`. A card that leaves it loses both. Nothing else expires.
- **Smoke projects:** a project is a smoke project if its name starts with `smoke-` when
  it is created; renaming never changes this. Every item written into a smoke project
  gets `expiresAt = project createdAt + 1 hour`, and the done-column rule never changes
  it. This follows `buildNote`, which picks the expiry once, at creation.
- **Expired items are absent.** DynamoDB TTL deletion is eventual, so the repo treats any
  item whose `expiresAt` has passed as missing: reads skip it, caps do not count it, and
  a `PATCH` or `DELETE` on it returns 404.

## API

Board routes are under `/api`, take and return JSON, and reject bodies over 16 KB (a
2000-character description can take up to 8 KB of UTF-8 before JSON escaping).
`/api/notes` keeps its 4 KB limit.

| Method and path | Behavior |
|---|---|
| `GET /projects` | List projects, oldest first. |
| `POST /projects` | Create a project with the three default columns. |
| `PATCH /projects/:projectId` | Rename. |
| `DELETE /projects/:projectId` | Delete every item in the project, then the project item. |
| `GET /projects/:projectId/board` | `{ project, columns, cards, labels }`. |
| `POST /projects/:projectId/columns` | Add a column. |
| `PATCH /projects/:projectId/columns/:columnId` | Rename or set `rank`. |
| `DELETE /projects/:projectId/columns/:columnId` | 409 if the column still has cards or is the done column. |
| `POST /projects/:projectId/cards` | Add a card. |
| `PATCH /projects/:projectId/cards/:cardId` | Any of `columnId`, `rank`, `title`, `description`, `labelIds`. A move is a `PATCH` that sets `columnId` and `rank`. |
| `DELETE /projects/:projectId/cards/:cardId` | Delete a card. |
| `POST /projects/:projectId/labels` | Add a label. |
| `PATCH /projects/:projectId/labels/:labelId` | Rename or recolor. |
| `DELETE /projects/:projectId/labels/:labelId` | Delete the label only. Cards keep its ID until their next write; reads drop IDs that no longer match a label. |

Rules:

- Every ID in a path or body must belong to the project in the path: 404 for a path ID,
  400 for a body ID.
- Caps: 50 projects (smoke projects not counted); per project 20 columns, 1000 cards and
  30 labels. The API counts live items in the partition before each create and returns
  409 at the cap. Caps are soft: two concurrent creates can exceed one by one.
- A project delete removes children first and the project item last, so a failure
  partway leaves a visible project that a second delete finishes.
- The SPA renders all user text as text, never as HTML.
- `/api/health` checks `Notes` until rollout step 2, then `Board` only.

## Risks and mitigations

| Risk | Mitigation or acceptance |
|---|---|
| Two tabs edit the same board; last write wins, and a failed save's undo can revert a later change. | Accepted: one owner. After any failed save the SPA reloads the board. |
| Caps can be exceeded by one under concurrent creates. | Accepted: caps bound cost, not correctness. |
| A rank cannot be computed, or grows past 64 characters. | Accepted: the move fails with undo and a toast. No rebalancing. |
| A project delete fails partway. | Children are deleted before the project item; deleting again finishes. |
| Data no longer expires, so anyone behind the owner's IP (threat-model residual risk 3) can read or delete long-lived projects. | Accepted and recorded in the threat model. Delete actions ask for confirmation. PITR on `Board` in prod allows a restore. |
| Cards hold more text for longer, so personal data is more likely. | The threat model's no-personal-data rule is restated for cards and projects. |
| Stored XSS through card, project or label text. | Text-only rendering; an E2E test puts an HTML/script payload in each field and checks it renders literally. |
| New UI packages widen the supply chain. | Each package is listed in its PR and pinned to an exact version in `package.json`. |
| Prod smoke fails because the owner is at the 50-project cap. | Smoke projects are not counted toward the cap. |

## Dependencies

New packages in `web/`:

- **Runtime:** the Radix primitives behind the chosen shadcn components (named in the PR
  that adds them), `@dnd-kit/core`, `@dnd-kit/sortable`, `fractional-indexing`, `sonner`,
  `lucide-react`. The shadcn components themselves are copied into
  `web/src/components/ui`.
- **Build:** `tailwindcss` v4 and `@tailwindcss/vite`, checked against the repo's Vite
  version.
- **Test:** `@axe-core/playwright` in `e2e/`.

The API adds `fractional-indexing` only if it validates ranks with the package;
otherwise none. All new packages use exact versions, which is new for this repo.

## Testing

- **Unit (API, Vitest):** validation for every route; the expiry rules (enter and leave
  done, smoke projects, renaming a smoke project); expired items treated as absent; caps,
  including smoke projects not counting; ID ownership; rank validation; 409 for deleting
  a column with cards or the done column; dangling label IDs dropped on read; project
  delete order; the repo layer against DynamoDB Local.
- **Infra:** the `Board` table's keys, TTL, removal policy and PITR, with its logical ID
  pinned; the Lambda role limited to the two tables; the `Notes` table unchanged.
- **E2E (Playwright, local build):** see the rollout step that adds each test.
- **Smoke (live):** create a `smoke-<sha>` project, add a card, move it from To do to
  Doing with a `PATCH`, read the board back, delete the project. The anonymous-403 test
  stays. The suite stays under one minute.

## Rollout

One PR per step. Each passes all four gates. No step removes a table, route or field
that the previous release uses, so redeploying `prod-good` after any step works.

0. **Threat model.** A docs-only PR updates `docs/threat-model.md` first, because the CI
   review and audit read it from the base branch. It covers board data that does not
   expire, the caps, the 16 KB board body limit, the new fields and their limits, the
   two-table Lambda role, the residual-risk 3 change and the personal-data rule.
1. **Board table and API.** `Board` table, `BoardRepo`, all board routes, unit and infra
   tests. The UI is unchanged. CLAUDE.md is updated for the two-table role and for which
   data expires.
2. **Board UI.** The new shell, theme, sidebar, project create/rename/delete, columns,
   cards (title only, edited inline) and drag and drop. The notes UI goes. The same PR:
   - replaces `e2e/tests/notes.spec.ts` with board E2E tests: projects; add, rename and
     delete columns; add cards; drag a card between columns with the mouse and with the
     keyboard; reorder columns and check the order after a reload; the expiry text on a
     card in Done; theme switch; the mobile sidebar; the literal-text XSS test for
     project, column and card text; an axe check on the board;
   - replaces the smoke tests "SPA loads" and "API round trip" with the board versions;
   - switches `/api/health` to `Board`;
   - updates CLAUDE.md (architecture and smoke conventions).
3. **Labels and the card side panel.** Label management, label chips, the label filter,
   and the side panel for title, description and labels. E2E tests for each, the XSS
   test for description and label names, and an axe check on the panel.
4. **Cleanup,** at least 7 days after step 2 reaches prod, when every note has expired:
   remove the `/api/notes` routes and notes code, the `Notes` grant and environment
   variable, and the related lines in CLAUDE.md and the threat model. The `Notes` table
   stays in the stack: removing it would only orphan it in prod (removal policy
   `RETAIN`), and deleting it by hand is click-ops. Removing it is a separate decision.
