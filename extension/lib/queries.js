// GraphQL doc_id map — extracted from I:\Convite BM\enviarconvitebm.har. Runs in the MAIN world
// so bridge.js can build the request bodies; kept in its own file so a future doc_id rotation is a
// one-file edit, same convention as I:\Manager Lite\extension\lib\queries.js.
(function () {
  const NS = (window.__CB_QUERIES__ = window.__CB_QUERIES__ || {});

  NS.queries = {
    // Lists every Business Manager scope the logged-in profile can see (the account-switcher's
    // "all businesses" query — NOT the narrower scope-selector query, which only returns the
    // currently active BM). Entry 79 of the HAR returned count:5 with all 5 BMs in one page;
    // countLimit is set well above any realistic profile size, and bridge.js still follows
    // page_info in case an account ever exceeds it.
    listBusinesses: {
      name: "NorthStarBusinessUnifiedScopingSelectorPopoverContainerAllFirstLevelScopesQuery",
      docId: "27905304652426662",
      vars: (ctx) => ({
        businessToolName: "MBS_SETTING",
        contextUri: "https://business.facebook.com/latest/settings/business_users",
        countLimit: 500,
        filterParams: { business_tool_name: "MBS_SETTING", should_check_inbox_onboarding: true },
        firstLevelScopeId: ctx.businessId,
        searchInput: "",
        zeroLevelScopeId: null,
        fetchNumberForBusinessScopes: 500,
        shouldEnableYAUsabilityImprovement: false,
        cursor: ctx.cursor || null,
      }),
    },

    // Sends the actual invite — full BM access (business_account_task_ids from the server's
    // /api/v1/me, no per-asset scoping). Ported verbatim from entry 224 of the HAR
    // (BizKitSettingsInvitePeopleModalMutation).
    invite: {
      name: "BizKitSettingsInvitePeopleModalMutation",
      docId: "31295717360015609",
      vars: (ctx) => ({
        input: {
          actor_id: ctx.actorId,
          client_mutation_id: "1",
          business_id: ctx.businessId,
          business_emails: [ctx.email],
          business_account_task_ids: ctx.taskIds,
          invite_origin_surface: "MBS_INVITE_USER_FLOW",
          assets: [],
          use_detailed_coded_exception: true,
          auto_assign_access: false,
          expiry_time: 0,
          is_spark_permission: false,
          client_timezone_id: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo",
        },
      }),
    },

    // On-demand reconciliation — lists existing users/pending invitations for one BM, used by the
    // "Verificar no Facebook" button. Not part of the automatic scan (one extra request per BM).
    peopleList: {
      name: "BizKitSettingsPeopleTableListPaginationQuery",
      docId: "26929347616691112",
      vars: (ctx) => ({
        id: ctx.businessId,
        asset_types: null,
        businessAccessType: null,
        businessAccountTypes: null,
        businessUserStatusType: null,
        cursor: null,
        first: 10,
        isUnifiedSettings: true,
        orderBy: "MOST_RECENTLY_CREATED",
        permissions: null,
        searchTerm: "",
        shouldUseNewEmptyState: false,
        __relay_internal__pv__BizKitSettingsPeopleEmptyStaterelayprovider: false,
      }),
    },
  };
})();
