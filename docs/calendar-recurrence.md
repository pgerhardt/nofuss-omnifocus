# Typed calendar recurrence

`update task` / MCP `nofuss_update` share the core `task.update` contract.
The recurrence object retains required `frequency`, `interval` (1–1000),
`schedule`, `anchor` and `catch_up`. Frequencies now include `monthly` and `yearly`.

Optional selectors are explicit and exclusive:

- Weekly: `weekdays`, a unique nonempty set of MO/TU/WE/TH/FR/SA/SU.
- Monthly: `month_days`, unique nonzero days -31…31 (negative days count backward),
  or `ordinal_weekday: {ordinal: -5…-1 or 1…5, weekday: MO…SU}`.
- Daily/yearly: interval only, anchored to the existing local due/defer date.

Selector sets normalize before request hashing. Native constructor normalization
must agree before setters; both independent read paths reject every unrepresented
rule component. Rules without an explicit INTERVAL read as interval 1. No raw ICS
input is accepted. Existing leaf/ancestor, authorization, date-edit separation,
catch-up and independent readback guards remain in force.

Example changes:

```json
{
  "recurrence": {
    "frequency": "monthly",
    "interval": 1,
    "schedule": "regularly",
    "anchor": "due",
    "catch_up": false,
    "ordinal_weekday": { "ordinal": -1, "weekday": "FR" }
  }
}
```

Installed OmniFocus evidence on 2026-10-01: monthly/yearly intervals round-tripped
for both schedules and local anchors; representative weekly sets/monthly selectors
round-tripped through durable core writes and independent exact reads. A plain
monthly interval advances January 31 to February's final day; explicit month day 31
skips February. Preserve native calendar/time-zone behavior, not fixed millisecond
arithmetic. Yearly BYMONTH forms were rejected by the installed constructor and
are unsupported. This narrows comparator claims using live native evidence.

`complete task` / MCP `nofuss_complete` now accepts explicit `occurrence: "current"`,
requiring host `allow_repeating_completion:true` plus the usual task.complete/project
scope. Support requires an unfinished ordinary leaf, either a future regular rule
without catch-up or a plain from-completion interval, exactly one local due/defer anchor, declared planned-date support,
and no planned/floating dates, alarms, attachments or unsafe ancestors. Batch completion
remains ordinary-only. Other repeating forms still reject before setters.

The first exact fixture showed that the
original ID continues and the returned completed object has a new history ID.
Setter-returned history initially had an unavailable added date, filled on a later
independent evaluation. The result resource is the completed history task; the original input task ID
identifies the continuing task. Readback verifies both exact objects, original metadata,
expected native next date and complete sibling membership. No history ID is synthesized.
Joint due/defer advancement remains outside this bounded contract.

## Native clock contract: from-completion advancement

Verified bounded contract, established on OmniFocus 4.9.2,
build 188.3.0 in America/Denver (machine offset UTC−06 at observation).
Plain daily/weekly/monthly/yearly intervals with one non-floating local due OR
defer anchor can now complete with the same explicit occurrence/host opt-in.
Past anchors are valid for from-completion; regular completion retains its future
anchor restriction. Independent prediction and exact generated-object checks remain mandatory.

The native rule for the tested interval forms is:

1. Take the completion instant's calendar date in the machine's local time zone.
2. Put the original task anchor's local hours/minutes/seconds/milliseconds onto
   that date. Normalize nonexistent local times **on this completion date**.
3. Pass this adjusted date to the existing native `firstDateAfterDate` rule.
   The tested calendar rules return minute precision, truncating seconds/milliseconds.

The old anchor supplies the clock, not its day/month/year or a separate exposed
recurrence anchor. The completion instant supplies the calendar date, not its clock.
The native rule supplies calendar interval/clamping semantics, not elapsed milliseconds.
The original ISO offset does not stay fixed across local DST.

| Evidence                                                                  | Native result                                                                                             |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Due-again daily, old 09:00 vs 16:30, completion 14:00                     | Next day at 09:00 vs 16:30                                                                                |
| Daily due-again AND start-again, completion 14:00 vs 22:30                | Same next date/09:00                                                                                      |
| Monthly due-again AND start-again, old January 15, completed September 20 | October 20, old clock                                                                                     |
| Weekly due/defer; yearly due/defer                                        | Completion date + native week/year, old clock                                                             |
| Monthly defer, completion January 31                                      | February 28 at old clock                                                                                  |
| Daily interval 2                                                          | Completion date + two calendar days, old clock                                                            |
| Floating versus non-floating daily                                        | Same observed local rule; floating flag retained                                                          |
| Fall DST due (floating/non-floating) and defer                            | 09:00 retained; UTC−06 → UTC−07; 25 hours between adjusted base and next date                             |
| Spring gap, old 02:30, next date March 8                                  | March 8 at 03:30, native normalization                                                                    |
| Completion ON March 8, old 02:30                                          | Normalize base to 03:30; March 9 at 03:30, NOT 02:30                                                      |
| Fall repeated 01:30                                                       | Target fold picks the earlier UTC−06 occurrence; completion on fold day advances to next day 01:30 UTC−07 |
| Old 09:12:34.567                                                          | Next occurrence at 09:12:00.000                                                                           |

Local AND effective dates were independently recorded for history and continuing
tasks. Fixture projects had no inherited dates; the two date projections agreed.
Native `markComplete(explicitDate)` permitted different completion times and DST
boundaries without changing the host clock. History readback verified the actual
completion instant. Construction, pre-completion recurrence, post-completion rule,
floating flags, project IDs and setter-returned history IDs are in the private ledger.
Original IDs continued; completed history IDs were captured from the returned Task,
never synthesized or selected by name/order/proximity.

### Prediction and remaining limits

Immediately before completing a supported repeating task, the core captures one
explicit completion instant, verifies the native prediction still matches the
planned next date, and passes that same instant to `markComplete`. A day/time-zone
change that changes the prediction conflicts before setters. Independent readback
verifies the generated completed-history identity, the continuing original identity,
and prediction using the history's actual completion timestamp plus the old anchor.

From-completion writes reject floating dates, custom weekly/monthly selectors,
dual/inherited/planned anchors, catch-up, alarms, attachments, groups and unsafe
ancestors before mutation. Same-zone floating observations do not establish travel
or cross-zone semantics. Safe bounded selector recurrence reads/writes remain
supported. Yearly BYMONTH constructors are unsupported. Regular overdue completion
remains rejected. Advanced recurrence/history forms remain deferred.
