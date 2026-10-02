// Native-algorithm double for the observed continuing-original/completed-clone contract.
export function repeatingFixture(native) {
  const next = "2096-02-29T12:00:00.000Z";
  native.project.task.tasks = native.project.tasks;
  native.task.dueDate = new Date("2096-01-31T12:00:00.000Z");
  native.task.repetitionRule = {
    ruleString: "FREQ=MONTHLY;INTERVAL=1",
    scheduleType: "Regularly",
    anchorDateKey: "DueDate",
    catchUpAutomatically: false,
    firstDateAfterDate: () => new Date(next),
  };
  native.task.markComplete = function () {
    native.events.push("repeatComplete");
    const history = new this.constructor(this.name, native.project);
    for (const field of [
      "dueDate",
      "deferDate",
      "plannedDate",
      "estimatedMinutes",
      "repetitionRule",
      "shouldUseFloatingTimeZone",
    ])
      history[field] = this[field];
    history.noteText = { ...this.noteText };
    history._flagged = this.flagged;
    history.tags = [...this.tags];
    history.completed = true;
    history.completionDate = new Date();
    this[
      this.repetitionRule.anchorDateKey === "PlannedDate"
        ? "plannedDate"
        : this.repetitionRule.anchorDateKey === "DeferDate"
          ? "deferDate"
          : "dueDate"
    ] = new Date(next);
    return history;
  };
  native.events.length = 0;
  return native;
}
