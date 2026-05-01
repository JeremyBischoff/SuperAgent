[TEST_FAIL]

[REASON] Agent was unable to retrieve the GitHub username due to proxy/token authentication failures

[BUG_FOUND] Proxy authentication failure: The agent attempted multiple methods to retrieve the GitHub username (direct /user API call, GraphQL viewer query, and public endpoints) but all requests through the proxy returned "401 Bad credentials". The proxy does not appear to be injecting a valid OAuth token for the connected GitHub account, preventing the agent from successfully retrieving the user's GitHub username.

[STEP] Navigated to http://localhost:47891 — Page loaded successfully with Super Agent application
[STEP] Clicked on agent "QA-20260501-015008-73eh" in the sidebar — Agent page loaded, showing idle status
[STEP] Verified agent status — Status displayed as "idle" (meets requirement of "running" or "idle")
[STEP] Typed message "Use the GitHub tool to check who I am. Tell me my GitHub username." in the input field — Message entered successfully in textbox
[STEP] Clicked Send button — Message was sent and agent began processing
[STEP] Account access request card appeared asking to grant GitHub access — Card displayed with GitHub account already selected (connected 1 minute ago)
[STEP] Clicked "Allow Access (1)" button — Access granted, agent continued processing
[STEP] API Request Review appeared for GET /user — Clicked Allow, then selected "Allow Once" from permission dialog
[STEP] API Request Review appeared for "Get GitHub user with verbose" — Clicked Allow, then selected "Allow Once" from permission dialog
[STEP] Bash command "Check related env vars" executed — Agent continued processing
[STEP] API Request Review appeared for GET /octocat — Clicked Allow, then selected "Allow Once" from permission dialog
[STEP] Agent detected bad credentials and requested to reconnect GitHub — Clicked "Allow Access (1)" to reconnect account
[STEP] API Request Review appeared for "Retry GitHub user lookup" GET /user — Clicked Allow, then selected "Allow Once" from permission dialog
[STEP] Agent completed processing with status "idle" — Final response displayed after 2 minutes 3 seconds
[STEP] Verified response for GitHub username — Response states: "I'm unable to determine your GitHub username... every call through the proxy — including `/user`, the GraphQL `viewer` query, and even public endpoints — returns `401 Bad credentials`". The response does NOT include a GitHub username; instead it reports authentication failure.
