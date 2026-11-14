# Memory doctrine

This is Yaad's one statement of what memory is and how it is kept. Dadi's long-term memory holds facts about Ankur's world, shared by every agent. The write path (extraction) and the agents that store and recall through the memory tools are bound by the same rules, stated once here.

## What memory is and is not

Memory is facts about Ankur's world and what became of them: his people, places, classes, deadlines, appointments, preferences, decisions, and how the things he did turned out.

**An agent's own working notes are not memory.** File paths, branches, commits, worktrees, where credentials are stored (Chaavi, a vault), and anything about "this agent", a wake, a worker, or an agent's own schedule or routine (a daily triage, a send run, an evening report) describe how an agent did its job, not Ankur's world. So does every lesson about how something works: how a site, page, login, second factor, account, tool, or repo behaves, what failed and what finally worked, the steps to get something done. Store none of it — not in a title and not in a body. A plain fact about Ankur's world that came with it stays: "Ankur's CSE 335 course site uses his College of Engineering login, not MSU SSO" is about his course; "the DECS login fills both fields in one call" is how-to.

**Progress on work an agent is doing for Ankur is not memory either.** Drafted, committed locally, not submitted yet, still needs his review — the agent tracks that itself and reports it to him. Store the work's deadline and requirements; never its progress, and never mark a task done for it.

**Records of things done are not memory.** What an agent can read back from the system that holds it, or that only says "this happened", is not stored: a score or grade on one graded item, when something was submitted (beyond marking its task done), the sets and weights of one workout, a single reading of weight or blood pressure, a confirmation number, an entry code, a one-time code. What is stored is what stays true and changes what someone does next: a final course grade, a standing policy, a trend that became a goal, a condition, a medication.

**Instructions to agents are not memory.** How an agent should do its job — "no agent may submit coursework", "always ask Ankur before sending", how to lay out his day, a LinkedIn note template, a routine's steps, who asks whom on Sundays — belongs in that agent's charter, not in Yaad. So do approvals and message trails ("Ankur approved the draft", "career-manager relayed the offer"). Store any fact about Ankur's world that came with it. A wish about how agents check on or message him (`does not want a daily message; each class checks at 7 AM`) is an instruction, however it is phrased.

## Node kinds

| kind | what it is |
| --- | --- |
| `person` | a human being Dadi knows |
| `place` | a real, nameable location that people live at, go to, or where things happen; an organization that is also a place (a university, an office, a gym, a restaurant) is a place |
| `plan` | an event at a real time on Ankur's timeline: a meeting, an appointment, an interview, a reservation, a flight, one session of a class, an exam at its hour, a trip's days. Something that was scheduled is a `plan` whether it is upcoming or already over |
| `task` | something Ankur has to get done, with no clock time to be at: an assignment, a form, a payment, an application, something to prepare |
| `memory` | one coherent fact, trait, preference, or unscheduled thing that happened — or the hub of a compound thing (a course, a job, a project, a device) |

## Plan or task: the one test

Does it have a clock time on a given day that Ankur is at? Then it is a plan (a quiz at 2 PM Thursday, an interview 3:00–3:30). Does it need doing by some point, with no time to be at? Then it is a task (homework due Friday 11:59 PM, a form due Oct 19, "apply to IBM"). A timed event that needs preparing is both: the plan, plus a task that closes when the plan starts.

## Plans

- **A plan is something with a real time.** An invite or proposal that carries a time ("dinner Saturday at 7") is a plan with `rsvp` absent. A proposal with no time ("dinner sometime next week", "we should grab coffee") has no time, so it is not a plan: it is a Someday task (§3.8) or, when nothing is to be done, nothing. When the time is later fixed, the Someday item is closed or updated and the plan is created once; never leave both.
- **`rsvp`** says whether Ankur is going: `"yes"`, `"no"`, or absent (unanswered; unanswered and yes plans block his free time, no does not). Set it only when the text says so: "Ankur is not going to the talk", "he does not plan to go to office hours" → `"no"`; "he will be there", "I'll go" → `"yes"`. A plan he declines **stays**: it still happens, so never close it for that; only `rsvp` changes. Never set rsvp on your own judgment of what he would want.
- **Called off.** An event that is not happening ("Priya cancelled Saturday's dinner", "it's not happening") is closed (`close_node`; one session of a course: `update_plans` with `set: { "close": true }`). Closing keeps a history record. A plan that is only proposed, or whose time is confirmed later, is the same plan: update it, never create a second.
- **`attended`** says whether Ankur was there, after the fact: `true` (he went) or `false` (he did not go), absent until someone says. Set it only when the text says so. A plan that was called off is closed, never `attended: false`.
- **Ankur may have set `rsvp` and `attended` by hand.** A value already stored is changed only when the text says it changed; a text that says nothing about them leaves them alone, and a create never sets them to null.
- **An invite is a plan, and his answer is the rsvp.** Something that invites Ankur to a time (an invite, a proposal, "X wants to meet Thu 3") is one plan at the stated time with `rsvp` absent. A later "I'm in" or "skip it" updates that same plan's `rsvp`. A confirmation of a proposed time ("Jake confirmed gym Fri 6pm, I'm in") updates the plan; it never creates a second one. Whether it clashes with another plan is for the agent to tell Ankur; it is never stored.
- **Only Ankur's life is stored.** A plan is something Ankur attends or does at a time he said: an appointment, a class session, "he will take the assessment Saturday 2:20–3:50 PM", a gym session he did. An agent's own routine — a daily inbox triage, an 8:00 AM send run, an evening report, a wake — is how agents work and is never stored. Time an agent proposes to lay out for him (a meal, a shower, a study block) is not stored either; nothing pre-lays his day. Someone else's availability — a professor's free hours to book, an advisor's drop-in slots, offered interview times — is not a plan until Ankur books one: it is one memory on that person or hub.
- **Time set aside for a task** ("he will take the IBM assessment Saturday 2:20–3:50 PM; the link expires Oct 31 at 11:59 PM") is a plan at that time linked `—FOR→` the task. The task keeps its close; never move it to the sitting and never clear it.

## Tasks: when something is relevant

A task says when it is relevant, not when to do it. Its only schedule is a window: `opens_on` (the first local day it shows, `YYYY-MM-DD`) and `closes_at` (the instant it is due, with offset). The window is decided from the text that states the task; nothing in Yaad fills either in later, so whoever states a task states the dates it needs. A task never has `occurred_at`.

**The close.** `closes_at` is the deadline as stated: "due Wed Nov 25 at 11:59 PM ET" → `"2026-11-25T23:59:00-05:00"`. A deadline with a date and no time closes at the end of that day, `23:59` local, and the body says `"Due time not stated."`; never invent another time. A moved deadline keeps its clock time unless the text gives a new one; `time not stated` never resets a moved close to `23:59`. A task with nothing to be done by (a Someday thing: "apply to IBM", "find a primary care doctor") has no close.

**The open — the hardest call.** A close needs an open, and an open never falls after the close day. Choose `opens_on` per item, from what the source says or what you know about it, in this order (Yaad brings an open the text does not state within bounds afterwards and reports it, so a close with no open is fine):

1. **Stated.** An open, release, or availability date ("opens Mon Oct 12", "Oct 1 2:00am – Oct 9") or a stated lead ("homework is released one week before it is due", "start the taxes in January") is the open.
2. **Already out.** An item the text says is posted, released, open, or assigned now ("was posted today", "is open on Codon", a list of what is due now) opens on the day it came out when the text states that day, else the day the text is from ("first seen tonight" is the day the text is from). A deadline Ankur states as his own, with no open, opens on the day he says it. An item in a term's schedule is not out just because the schedule is.
3. **One day.** Something taken or handed in on one day with no clock time to be at — a quiz, an exam, a form "on Friday" — opens on that day: `opens_on` = the close day.
4. **Nothing said.** A future item from a schedule or syllabus opens a lead before its own close: about **7 days**, never before the day of the text, for a homework, reading, quiz, form, or other small deliverable; about **14 days** for a project, essay, paper, or application; about **21 days** for a term project's final report. A list of deadlines never opens all at once: each item gets its own open from its own close.
5. **Someday.** No close and nothing says when it starts: no window at all. It shows on no particular day until it gets one.

A Someday task is something Ankur himself means to do ("apply to IBM", "find a primary care doctor"). A condition, a rule, or a preference ("a physician must evaluate him before any stimulant restart", "keep a lower-body day") is a memory on what it is about, never a task, and a question an agent has not checked yet ("whether she is in-network is still unchecked") is that agent's work, not a task of Ankur's.

A thing to prepare for a timed plan (studying for an exam, packing for a flight) is its own task closing when the plan starts, opening per the rules above, linked task `—FOR→` plan.

**Done.** A task is done when Ankur says he did it, or an agent did it at his yes ("I sent in the scholarship essay", "yes, submit it" followed by the agent's report that it did). That is `detail.done: true`, set like any other field. `done: false` only when the text says it is not done ("I didn't actually send it", "Correction: Q5 is not submitted"). Restating a task never changes `done`: leave it out. None of these says Ankur did it:
- an agent's paraphrase or report that carries no word of his ("Ankur says it is submitted" for "submit on the portal")
- a page, portal, gradebook or file listing (an upload, a `Submitted` badge, a score)
- where the task is handed in
- a draft that is ready, or an agent expecting it to be done

Yaad records when the flag changed. Never write a done time into the body.

**Already closed.** An item that closed before the day of the text is stored only when Ankur's own words state it ("I missed HW3, it was due yesterday"). A site list of old items is a record, not his deadlines; Yaad reports what it leaves out.

**One task per deliverable.** Weekly homework is one task per assignment, as the syllabus lists them; there are no repeating tasks.

Only Ankur's own deliverables are tasks. A stage the instructor or the system runs (grading, release, evaluation windows he does not act in) is not a task: it goes in the deliverable's body. A module, unit or week that holds items is their hub (a memory), never a task; its items are the tasks.

## Say exactly what the source says

- **A venue is where, never whether.** "(Gradescope)", "on D2L", "submit via CLion", "in person" say where something is handed in or happens. They never mean it was submitted or done. Write where it is handed in as an instruction (`"Submit on Gradescope."`) in the body. Never write `submitted`, `uploaded`, `turned in` or `done` in a title or body unless this utterance says Ankur did it; a past participle of where it goes reads as done. A task is done only when the text says Ankur did it or an agent did it at his yes.
- **Say exactly what the source says, never more.** Being enrolled in something is not attending or doing it. Being listed in a portal is not participating. Planning to go is not having gone. A venue is not a submission. Upgrading the verb invents a fact.

## Corrections

**A correction fixes the node it names.** When something stored is wrong, retracted, or superseded, say so outright: "Correction: <old claim> is wrong; <new claim>." The correction is applied to the stored node it names: the wrong mark is cleared, the body or window fixed, never a second node beside it, and never closing a thing that still exists because one of its fields was wrong. A fact simply left out of a later statement is not removed. A correction is never a working note, even when the rest of what came with it is progress that is dropped: dropping it leaves the wrong fact live for every agent that recalls it. A "correction" that only restates what is already stored changes nothing.

## Freshness

A fact about Ankur's world stays true until someone says otherwise, with one exception: a task. A task's state (open or done, its close) changes in the world without anyone telling memory. So each task carries `verified_at`, which changes when the task is:
- created
- changed
- marked done or not done
- restated as still true (through a noop's `node_ids` or `POST /tasks/verify`)

Each course hub also carries a `verified_at`. Any store or verify touching a task under it stamps it. Recall reports the hub as `verified_today`. A course whose hub is not verified today is stale for "what is due". Whoever reads its source refreshes it, and anyone else asks the course's owner. A stale task is still the best lead, never a reason to say nothing is known.
