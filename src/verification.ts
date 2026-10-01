// Evidence describes this native build, not declarations or every possible field value.
// See docs/alpha-readiness.md for independent checks, test-only cases and fixture gaps.
export const READ_VERIFICATION = {
  recorded_native: { version: "4.9.2", build: "188.3" },
  basis: "independent_native_checks" as const,
  verified_reads: [
    "exact_ids_and_entities",
    "inbox_and_project_scopes",
    "local_and_effective_states",
    "project_types_statuses_dates_counts_review",
    "query_and_tree_membership_order",
    "field_selection_and_text_windows",
    "overview_and_explicit_waiting",
    "notifications_normalized_core_cli_mcp_and_continuation",
    "library_discovery_and_exact_taxonomy_hierarchy",
    "task_scheduling_including_planned_millisecond_dates",
    "bounded_recurrence_and_absolute_due_relative_alarms",
    "from_completion_plain_single_anchor_native_clock_and_dst",
    "bounded_ordinary_subtree_lifecycle_and_exact_sibling_reorder",
    "perspective_inventory_archives_and_selected_visible_window",
  ],
  gaps: [
    "notifications_rare_states_not_live_verified",
    "oversized_collections_test_only",
    "rare_positive_library_filter_shapes_test_only",
    "perspective_custom_selected_and_no_window_evaluation_test_only",
    "waiting_overlap_and_tagged_inbox_test_only",
  ],
  exceptions: {
    project_direct_counts_and_review_fixed: "native_scripting_supplement",
    native_collections: "array_like_not_necessarily_Array",
    available_child_count: "gated_unresolved_semantics",
    defer_relative_notifications: "unsupported",
    from_completion_completion:
      "plain non-floating single local due/defer intervals only; custom selectors, floating/travel, dual/inherited/planned anchors remain unsupported",
    notification_relative_offsets:
      "declarations say minutes; raw seconds divided by 60 without version gating; live-confirmed on 4.9.2 (188.3), affected version range unknown",
  },
};
