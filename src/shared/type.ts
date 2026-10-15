export enum MessageType {
    START_OAUTH, REMOVE_OTHER_PAGE, UPDATE_PAGE, FETCH_PR_DIFF_INFO, FETCH_FILE_CONTENT
}

export enum StorageType {
    GITHUB_OAUTH_TOKEN = "githubOauthToken",
    INPUT_TOKEN = "inputToken",
    LAST_NON_ACTIVATED_ALERT_VERSION = "lastNonActivatedAlertVersion",
    PR_DIFF_VIEW_MODE = "prDiffViewMode"
}