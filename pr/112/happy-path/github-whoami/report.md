[TEST_FAIL]

[REASON] Agent attempted to use GitHub tool but failed to retrieve GitHub username due to invalid OAuth token

[BUG_FOUND] The agent received "Bad credentials" error when trying to fetch the authenticated GitHub user. The OAuth token for the connected GitHub account appears to be broken or invalid. The agent requested multiple times to get the authenticated user but each attempt failed with the same error. The final response was an error message asking the user to reconnect the GitHub account, rather than providing a GitHub username.

[STEP] Navigated to http://localhost:47891 — Page loaded successfully with the SuperAgent app showing 3 agents in the sidebar

[STEP] Clicked on "QA-20260508-171648-mec2" agent in the sidebar — Agent page loaded showing the idle status

[STEP] Verified agent status — Status displayed as "idle" in the header

[STEP] Typed and sent message "Use the GitHub tool to check who I am. Tell me my GitHub username." — Message was sent and agent began processing with status changing to "working"

[STEP] Granted GitHub account access when card appeared — Clicked "Allow Access (1)" to grant the GitHub account connection

[STEP] Approved GitHub API GET /user permission request (first attempt) — Clicked "Allow Once" to permit the API call

[STEP] Approved GitHub API GET /user permission request (second attempt) — Clicked "Allow Once" again as another permission request appeared

[STEP] Approved GitHub API GET /user permission request with "Always allow read:user" — Selected "Always allow read:user" for permanent read access to GitHub user profile

[STEP] Waited approximately 8 minutes 30 seconds for agent to complete — Agent finished with "Worked for 8m 30s" message

[STEP] Verified final response — Response showed error: "The GitHub proxy is returning 'Bad credentials' — the OAuth token attached to the connected account isn't being accepted by GitHub. The connection appears to be broken." No GitHub username was provided.
