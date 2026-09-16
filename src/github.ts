import type { context } from "@actions/github";
import type { GitHub } from "@actions/github/lib/utils";
import type { components } from "@octokit/openapi-types";

type Context = typeof context;
type Octokit = InstanceType<typeof GitHub>;

interface PullRequestData {
  details: components["schemas"]["pull-request"] | null;
  firstApprovedAt: string | null;
  firstCommitAuthorDate: string | null;
  labels: string[];
  readyForReviewAt: string | null;
}

// Modest cap to stay clear of GitHub's secondary rate limits on concurrent requests
const MAX_CONCURRENT_REQUESTS = 8;

async function mapWithConcurrency<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_REQUESTS, items.length) }, worker));
  return results;
}

async function getWorkflowRun(context: Context, octokit: Octokit, runId: number) {
  const res = await octokit.rest.actions.getWorkflowRun({
    ...context.repo,
    run_id: runId,
  });
  return res.data;
}

async function listJobsForWorkflowRun(context: Context, octokit: Octokit, runId: number) {
  return await octokit.paginate(octokit.rest.actions.listJobsForWorkflowRun, {
    ...context.repo,
    run_id: runId,
    filter: "latest", // risk of missing a run if re-run happens between Action trigger and this query
    per_page: 100,
  });
}

async function getJobsAnnotations(context: Context, octokit: Octokit, jobIds: number[]) {
  const annotations: Record<number, components["schemas"]["check-annotation"][]> = {};
  const results = await mapWithConcurrency(jobIds, (jobId) => listAnnotations(context, octokit, jobId));

  for (const [i, jobId] of jobIds.entries()) {
    annotations[jobId] = results[i];
  }
  return annotations;
}

async function listAnnotations(context: Context, octokit: Octokit, checkRunId: number) {
  return await octokit.paginate(octokit.rest.checks.listAnnotations, {
    ...context.repo,
    check_run_id: checkRunId,
  });
}

async function getPRsLabels(context: Context, octokit: Octokit, prNumbers: number[]) {
  const labels: Record<number, string[]> = {};
  const results = await mapWithConcurrency(prNumbers, (prNumber) => listLabelsOnIssue(context, octokit, prNumber));

  for (const [i, prNumber] of prNumbers.entries()) {
    labels[prNumber] = results[i];
  }
  return labels;
}

async function listLabelsOnIssue(context: Context, octokit: Octokit, prNumber: number) {
  return await octokit.paginate(
    octokit.rest.issues.listLabelsOnIssue,
    {
      ...context.repo,
      issue_number: prNumber,
    },
    (response) => response.data.map((issue) => issue.name)
  );
}

async function getPullRequest(context: Context, octokit: Octokit, prNumber: number) {
  const res = await octokit.rest.pulls.get({
    ...context.repo,
    pull_number: prNumber,
  });
  return res.data;
}

async function listPullRequestCommits(context: Context, octokit: Octokit, prNumber: number) {
  return await octokit.paginate(octokit.rest.pulls.listCommits, {
    ...context.repo,
    pull_number: prNumber,
    per_page: 100,
  });
}

async function listPullRequestReviews(context: Context, octokit: Octokit, prNumber: number) {
  return await octokit.paginate(octokit.rest.pulls.listReviews, {
    ...context.repo,
    pull_number: prNumber,
    per_page: 100,
  });
}

async function listPullRequestEvents(context: Context, octokit: Octokit, prNumber: number) {
  return await octokit.paginate(octokit.rest.issues.listEvents, {
    ...context.repo,
    issue_number: prNumber,
    per_page: 100,
  });
}

const SQUASH_MERGE_PATTERN = /\(#(\d+)\)$/m;
const MERGE_COMMIT_PATTERN = /^Merge pull request #(\d+)/m;

function extractPRNumberFromCommitMessage(message: string | null | undefined): number | null {
  if (!message) {
    return null;
  }

  // Pattern 1: Squash merge format: "Title (#123)"
  const squashMatch = message.match(SQUASH_MERGE_PATTERN);
  if (squashMatch) {
    return Number.parseInt(squashMatch[1], 10);
  }

  // Pattern 2: Merge commit format: "Merge pull request #123 from..."
  const mergeMatch = message.match(MERGE_COMMIT_PATTERN);
  if (mergeMatch) {
    return Number.parseInt(mergeMatch[1], 10);
  }

  return null;
}

export {
  extractPRNumberFromCommitMessage,
  getJobsAnnotations,
  getPRsLabels,
  getPullRequest,
  getWorkflowRun,
  listJobsForWorkflowRun,
  listPullRequestCommits,
  listPullRequestEvents,
  listPullRequestReviews,
  type Octokit,
  type PullRequestData,
};
