## Test Report

[TEST_FAIL]

[REASON] Agent attempted to fetch GitHub username but received "Bad credentials" error due to invalid/expired OAuth token, preventing successful username retrieval.

[BUG_FOUND] GitHub OAuth Token Invalid/Expired - The agent successfully invoked the GitHub tool and made multiple API calls to fetch the authenticated user's information, but received "Bad credentials" errors from GitHub. The response message indicates the OAuth token attached to the connected GitHub account is invalid or expired. The agent could not complete the requested task of retrieving the GitHub username due to this authentication failure.

[STEP] Navigated to http://localhost:47891 — Page loaded successfully with sidebar showing three agents including "QA-20260508-205631-m8o0"

[STEP] Clicked on agent "QA-20260508-205631-m8o0" in the agents list — Agent page opened successfully

[STEP] Verified agent status is "running" or "idle" — Agent status showed "idle" in the status indicator

[STEP] Sent message "Use the GitHub tool to check who I am. Tell me my GitHub username." — Message was sent successfully and agent transitioned to "working" status

[STEP] GitHub account access request card appeared asking to grant access — Card displayed with GitHub account option selected

[STEP] Clicked "Allow Access" button to grant GitHub account access — GitHub access was granted successfully

[STEP] Multiple GitHub API permission dialogs appeared (GET /user requests) — Selected "Allow Once" for each permission request to allow agent to make API calls

[STEP] Agent completed processing after 2 minutes 8 seconds — Agent returned an error response instead of GitHub username

[STEP] Reviewed agent response — Response stated: "The GitHub connection returned 'Bad credentials' from GitHub itself — the proxy is forwarding correctly but the OAuth token attached to your connected GitHub account appears invalid or expired." The agent did not return a GitHub username as required by step 7.
