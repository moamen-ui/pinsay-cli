# CLAUDE.md

Guidance for AI agents working in pinsay-cli.

## Media hand-off (PinSay videos)

PinSay's videos must follow the product. When a **user-visible** change in this repo is finished and committed (new or
renamed UI labels, screens, CLI commands, flags or defaults, permissions, visible API behaviour, removed features), hand it
off to the PinSay media agent before you report done:

1. Write a hand-off file `/Users/momen/Desktop/PRIVATE/pinsay/pinsay-media/handoffs/<YYYY-MM-DD>-<slug>.md` from
   `handoffs/_TEMPLATE.md` there: the repo and commits, the user-visible effect, the details and key files. `Status: queued`.
2. If you can launch agents, launch the `pinsay-media` agent with that file's path (Claude Code: the `pinsay-media`
   subagent; agy/opencode: the agent of the same name). Otherwise tell the owner the hand-off is queued.
3. Do not edit the media repo yourself, and do not wait for the videos: the media agent updates the affected videos and
   proposes new ones for the owner to approve.

Internal refactors, tests, and changes nobody can see need no hand-off.
