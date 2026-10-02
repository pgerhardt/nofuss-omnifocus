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
    "from_completion_single_anchor_clock_dst_selectors_and_planned",
    "bounded_embedded_attachment_content_and_lifecycle",
    "native_local_sync_facts_and_tag_location_metadata",
    "native_taskpaper_export_and_ordinary_outline_import",
    "bounded_ordinary_subtree_lifecycle_and_exact_sibling_reorder",
    "perspective_inventory_archives_and_selected_visible_window",
    "ordinary_task_restoration_and_exact_task_project_conversion",
    "forecast_next_action_preferences_and_direct_calendar_review_date",
    "plain_note_replacement_rejects_rich_or_unknown_native_content",
    "regular_due_only_single_alarm_history_and_continuing_identity",
    "typed_due_tag_project_focus_search_leaf_disabled_and_rgb_icons",
    "native_xml_metadata_import_and_selected_folder_exports",
    "larger_embedded_bytes_and_bounded_directory_metadata",
  ],
  gaps: [
    "notifications_rare_states_not_live_verified",
    "oversized_collections_test_only",
    "rare_positive_library_filter_shapes_test_only",
    "perspective_custom_selected_and_no_window_evaluation_test_only",
    "waiting_overlap_and_tagged_inbox_test_only",
    "nonempty_plugin_inventory_test_only",
    "attachment_link_metadata_live_fixture_denied_by_native_sandbox",
  ],
  exceptions: {
    project_direct_counts_and_review_fixed: "native_scripting_supplement",
    native_collections: "array_like_not_necessarily_Array",
    available_child_count: "gated_unresolved_semantics",
    defer_relative_notifications:
      "installed_kind_absent; comparator due_constructor_alias_not_equivalent",
    attachment_link_metadata:
      "installed_Link_enum_and_readonly_destination_declaration_plus_double; live_fixture_denied",
    advanced_completion_profiles:
      "deliberate_NFO9_safety_exclusion; NFO40_future_native_proof_backlog",
    from_completion_completion:
      "non-floating single local due/defer/planned intervals and weekly/monthly selectors; floating/travel, dual/inherited anchors and catch-up completion unsupported",
    notification_relative_offsets:
      "declarations say minutes; raw seconds divided by 60 without version gating; live-confirmed on 4.9.2 (188.3), affected version range unknown",
  },
};
