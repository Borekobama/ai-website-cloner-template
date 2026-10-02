# <Page> — behaviours

A screenshot shows one state and no movement. Interaction models below are
inferred from the controls shown and implemented with mock data. Mark each
row as observed (seen in a screenshot state) or inferred.

| Control | Model | Implementation | Evidence |
|---|---|---|---|
| <Nav item> | click → route | `<Link>`, active style … | observed |
| <Menu button> | click → menu | items …, closes on Escape and outside click | observed (page `<page>-menu-open`) |
| <Search field> | type → filter | filters rows by …, debounce … | inferred |
| <Upload button> | click → file chooser | adds a row, simulated checks | inferred |

States captured in the references: <default, menu open, …>.
Added states: hover, pressed, focus ring, open and close motion.
