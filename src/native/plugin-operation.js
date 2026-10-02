function pluginOperation(envelope) {
  try {
    const all = PlugIn.all;
    if (all.length > 50) throw Error("limit");
    let actionCount = 0;
    const plugins = all
      .map((p) => {
        const actions = p.actions;
        actionCount += actions.length;
        if (actionCount > 200) throw Error("limit");
        if (
          typeof p.identifier !== "string" ||
          p.identifier.length > 256 ||
          typeof p.displayName !== "string" ||
          p.displayName.length > 512
        )
          throw Error("metadata");
        return {
          identifier: p.identifier,
          name: p.displayName,
          version: String(p.version),
          actions: actions
            .map((a) => {
              if (
                typeof a.name !== "string" ||
                !a.name ||
                a.name.length > 256 ||
                typeof a.label !== "string" ||
                a.label.length > 512 ||
                p.action(a.name) !== a
              )
                throw Error("identity");
              return { identifier: a.name, label: a.label };
            })
            .sort((a, b) => a.identifier.localeCompare(b.identifier)),
        };
      })
      .sort((a, b) => a.identifier.localeCompare(b.identifier));
    return JSON.stringify({
      request_id: envelope.request_id,
      result: {
        plugins,
        invocation: "intentionally_excluded",
        observed_at: new Date().toISOString(),
      },
    });
  } catch (_) {
    return JSON.stringify({
      request_id: envelope.request_id,
      error: {
        code: "NATIVE_UNAVAILABLE",
        message:
          "Bounded installed plug-in/action metadata or exact identity unavailable",
      },
    });
  }
}
