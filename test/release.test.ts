import { describe, expect, it } from "vitest";
import { reportVersionFor } from "../src/tools/curated.js";
import { connect, gzipTsv, json, mockFetch, resultText, type Recorded } from "./helpers.js";

// ---------- a fake Apple for releases, TestFlight and app info ----------

function fakeApple(opts: { versionState?: string; phased?: string; appInfoStates?: string[]; betaSubmitted?: boolean; localizations?: string[] } = {}) {
  const versions = () => ({
    data: [{ type: "appStoreVersions", id: "v1", attributes: { versionString: "3.0", platform: "IOS", appVersionState: opts.versionState ?? "PENDING_DEVELOPER_RELEASE", createdDate: "2026-10-01" } }],
  });
  let phased = opts.phased;
  const notes = new Map<string, { id: string; whatsNew?: string }>((opts.localizations ?? ["en-US"]).map((l, i) => [l, { id: `bbl-${i}`, whatsNew: "old" }]));
  const handler = (req: Recorded): Response | undefined => {
    const p = req.url.pathname;
    const m = `${req.method} ${p}`;
    if (m === "GET /v1/apps/A/appStoreVersions") {
      const v = versions();
      if (req.url.searchParams.get("include") === "appStoreVersionPhasedRelease" && phased) {
        (v.data[0] as any).relationships = { appStoreVersionPhasedRelease: { data: { type: "appStoreVersionPhasedReleases", id: "pr1" } } };
        return json({ ...v, included: [{ type: "appStoreVersionPhasedReleases", id: "pr1", attributes: { phasedReleaseState: phased, currentDayNumber: 3 } }] });
      }
      return json(v);
    }
    if (m === "GET /v1/appStoreVersions/v1/appStoreVersionPhasedRelease") {
      return phased
        ? json({ data: { type: "appStoreVersionPhasedReleases", id: "pr1", attributes: { phasedReleaseState: phased, currentDayNumber: 3 } } })
        : json({ errors: [{ status: "404", title: "Not found" }] }, 404);
    }
    if (m === "POST /v1/appStoreVersionPhasedReleases") {
      phased = req.body.data.attributes.phasedReleaseState;
      return json({ data: { type: "appStoreVersionPhasedReleases", id: "pr1", attributes: { phasedReleaseState: phased } } }, 201);
    }
    if (m === "PATCH /v1/appStoreVersionPhasedReleases/pr1") {
      phased = req.body.data.attributes.phasedReleaseState;
      return json({ data: { type: "appStoreVersionPhasedReleases", id: "pr1", attributes: { phasedReleaseState: phased } } });
    }
    if (m === "GET /v1/builds/b1/betaBuildLocalizations") {
      return json({ data: [...notes].map(([locale, n]) => ({ type: "betaBuildLocalizations", id: n.id, attributes: { locale, whatsNew: n.whatsNew } })) });
    }
    if (m === "GET /v1/betaAppReviewSubmissions") {
      return json({ data: opts.betaSubmitted ? [{ type: "betaAppReviewSubmissions", id: "s0", attributes: { betaReviewState: "WAITING_FOR_REVIEW" } }] : [] });
    }
    if (m === "GET /v1/apps/A/appInfos") {
      const states = opts.appInfoStates ?? ["READY_FOR_DISTRIBUTION", "PREPARE_FOR_SUBMISSION"];
      return json({
        data: states.map((state, i) => ({
          type: "appInfos",
          id: `ai${i}`,
          attributes: { state },
          relationships: { appInfoLocalizations: { data: [{ type: "appInfoLocalizations", id: `ail${i}` }] } },
        })),
        included: states.map((_, i) => ({ type: "appInfoLocalizations", id: `ail${i}`, attributes: { locale: "en-US", name: `Name ${i}`, subtitle: "Old" } })),
      });
    }
    return undefined;
  };
  return { ...mockFetch(handler), phased: () => phased };
}

const sent = (calls: Recorded[]) => calls.map((c) => `${c.method} ${c.url.pathname}`);

describe("asc_release_version", () => {
  it("releases a version waiting for a manual release", async () => {
    const apple = fakeApple();
    const client = await connect("write", apple.fn);
    const res: any = await client.callTool({ name: "asc_release_version", arguments: { appId: "A" } });
    expect(res.isError, resultText(res)).toBeFalsy();
    const post = apple.calls.find((c) => c.method === "POST")!;
    expect(post.url.pathname).toBe("/v1/appStoreVersionReleaseRequests");
    expect(post.body.data.relationships.appStoreVersion.data).toEqual({ type: "appStoreVersions", id: "v1" });
  });

  it("refuses any other state without contacting the release endpoint", async () => {
    const apple = fakeApple({ versionState: "WAITING_FOR_REVIEW" });
    const client = await connect("write", apple.fn);
    const res: any = await client.callTool({ name: "asc_release_version", arguments: { appId: "A" } });
    expect(resultText(res)).toMatch(/is WAITING_FOR_REVIEW; only a version in PENDING_DEVELOPER_RELEASE/);
    expect(apple.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("is hidden in read-only mode", async () => {
    const client = await connect("readonly", fakeApple().fn);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("asc_release_version");
    expect(names).toContain("asc_list_app_info");
  });
});

describe("asc_phased_release", () => {
  it("reports no phased release, enables one, then pauses and completes it", async () => {
    const apple = fakeApple({ versionState: "PREPARE_FOR_SUBMISSION" });
    const client = await connect("write", apple.fn);
    const call = async (action: string) => JSON.parse(resultText(await client.callTool({ name: "asc_phased_release", arguments: { appId: "A", action } })));

    expect((await call("status")).phasedRelease).toBeNull();
    expect((await call("enable")).phasedRelease.phasedReleaseState).toBe("INACTIVE");
    expect((await call("enable")).note).toMatch(/already set up/);
    expect((await call("pause")).phasedRelease.phasedReleaseState).toBe("PAUSED");
    expect((await call("resume")).phasedRelease.phasedReleaseState).toBe("ACTIVE");
    expect((await call("complete")).phasedRelease.phasedReleaseState).toBe("COMPLETE");
  });

  it("needs full mode to remove a phased release", async () => {
    const client = await connect("write", fakeApple({ phased: "INACTIVE" }).fn);
    const res: any = await client.callTool({ name: "asc_phased_release", arguments: { appId: "A", action: "disable" } });
    expect(resultText(res)).toMatch(/switch the mode to "full"/);
  });

  it("asks to enable before pausing", async () => {
    const client = await connect("write", fakeApple().fn);
    const res: any = await client.callTool({ name: "asc_phased_release", arguments: { appId: "A", action: "pause" } });
    expect(resultText(res)).toMatch(/no phased release. Use action "enable"/);
  });
});

describe("asc_distribute_build", () => {
  it("writes notes, submits for beta review, then adds the build to groups", async () => {
    const apple = fakeApple();
    const client = await connect("write", apple.fn);
    const res: any = await client.callTool({
      name: "asc_distribute_build",
      arguments: { buildId: "b1", betaGroupIds: ["g1", "g2"], whatToTest: { "en-US": "Try export", "de-DE": "Teste Export" }, submitForBetaReview: true },
    });
    expect(res.isError, resultText(res)).toBeFalsy();
    const writes = sent(apple.calls).filter((c) => !c.startsWith("GET"));
    expect(writes).toEqual([
      "PATCH /v1/betaBuildLocalizations/bbl-0",
      "POST /v1/betaBuildLocalizations",
      "POST /v1/betaAppReviewSubmissions",
      "POST /v1/betaGroups/g1/relationships/builds",
      "POST /v1/betaGroups/g2/relationships/builds",
    ]);
    const created = apple.calls.find((c) => c.method === "POST" && c.url.pathname === "/v1/betaBuildLocalizations")!;
    expect(created.body.data.attributes).toEqual({ locale: "de-DE", whatsNew: "Teste Export" });
  });

  it("skips groups that get every build, and keeps going when one group refuses", async () => {
    const apple = mockFetch((req) => {
      const m = `${req.method} ${req.url.pathname}`;
      if (m === "GET /v1/betaGroups") {
        return json({
          data: [
            { type: "betaGroups", id: "auto", attributes: { name: "Internal", isInternalGroup: true, hasAccessToAllBuilds: true } },
            { type: "betaGroups", id: "bad", attributes: { name: "Broken", isInternalGroup: false } },
            { type: "betaGroups", id: "ok", attributes: { name: "Ext", isInternalGroup: false } },
          ],
        });
      }
      if (m === "POST /v1/betaGroups/bad/relationships/builds") {
        return json({ errors: [{ status: "422", code: "ENTITY_UNPROCESSABLE", title: "Not allowed" }] }, 422);
      }
      return undefined;
    });
    const client = await connect("write", apple.fn);
    const res: any = await client.callTool({ name: "asc_distribute_build", arguments: { buildId: "b1", betaGroupIds: ["auto", "bad", "ok"] } });
    expect(res.isError, resultText(res)).toBeFalsy();
    const out = JSON.parse(resultText(res));
    expect(out.groups.map((g: any) => [g.group, g.result])).toEqual([
      ["Internal", "skipped"],
      ["Broken", "failed"],
      ["Ext", "added"],
    ]);
    expect(out.groups[0].reason).toMatch(/receives every build automatically/);
    expect(apple.calls.some((c) => c.url.pathname === "/v1/betaGroups/auto/relationships/builds")).toBe(false);
  });

  it("doesn't submit twice for beta review", async () => {
    const apple = fakeApple({ betaSubmitted: true });
    const client = await connect("write", apple.fn);
    const out = JSON.parse(resultText(await client.callTool({ name: "asc_distribute_build", arguments: { buildId: "b1", submitForBetaReview: true } })));
    expect(out.betaReview.note).toBe("Already submitted");
    expect(apple.calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("app info", () => {
  it("lists live and editable app info", async () => {
    const client = await connect("readonly", fakeApple().fn);
    const out = JSON.parse(resultText(await client.callTool({ name: "asc_list_app_info", arguments: { appId: "A" } })));
    expect(out.appInfos.map((i: any) => [i.state, i.editable])).toEqual([
      ["READY_FOR_DISTRIBUTION", false],
      ["PREPARE_FOR_SUBMISSION", true],
    ]);
    expect(out.appInfos[1].localizations[0]).toMatchObject({ locale: "en-US", name: "Name 1" });
  });

  it("edits the app info being prepared, never the live one", async () => {
    const apple = fakeApple();
    const client = await connect("write", apple.fn);
    const res: any = await client.callTool({ name: "asc_update_app_info", arguments: { appId: "A", locale: "en-US", subtitle: "Faster exports" } });
    expect(res.isError, resultText(res)).toBeFalsy();
    const patch = apple.calls.find((c) => c.method === "PATCH")!;
    expect(patch.url.pathname).toBe("/v1/appInfoLocalizations/ail1");
    expect(patch.body.data.attributes).toEqual({ subtitle: "Faster exports" });
  });

  it("explains when nothing can be edited, or the language is missing", async () => {
    const live = await connect("write", fakeApple({ appInfoStates: ["READY_FOR_DISTRIBUTION"] }).fn);
    expect(resultText(await live.callTool({ name: "asc_update_app_info", arguments: { appId: "A", locale: "en-US", name: "New" } }))).toMatch(
      /No app info can be edited right now[\s\S]*Create a new App Store version/,
    );
    const client = await connect("write", fakeApple().fn);
    expect(resultText(await client.callTool({ name: "asc_update_app_info", arguments: { appId: "A", locale: "fr-FR", name: "Nouveau" } }))).toMatch(/No fr-FR localization/);
    expect((await client.callTool({ name: "asc_update_app_info", arguments: { appId: "A", locale: "en-US", subtitle: "x".repeat(31) } })).isError).toBe(true);
  });
});

describe("overview and lists", () => {
  it("shows phased-release progress in the app overview", async () => {
    const client = await connect("readonly", fakeApple({ phased: "ACTIVE" }).fn);
    const out = JSON.parse(resultText(await client.callTool({ name: "asc_app_overview", arguments: { appId: "A" } })));
    expect(out.appStoreVersions[0].phasedRelease).toMatchObject({ phasedReleaseState: "ACTIVE", currentDayNumber: 3 });
  });

  it("returns nextUrl when there are more apps", async () => {
    const next = "https://api.appstoreconnect.apple.com/v1/apps?cursor=x";
    const client = await connect("readonly", mockFetch(() => json({ data: [{ type: "apps", id: "1", attributes: { name: "A" } }], links: { next } })).fn);
    const out = JSON.parse(resultText(await client.callTool({ name: "asc_list_apps", arguments: {} })));
    expect(out).toMatchObject({ more: true, nextUrl: next });
  });
});

describe("sales report version", () => {
  it("retries once with the version Apple names", async () => {
    let n = 0;
    const apple = mockFetch(() =>
      n++ === 0 ? json({ errors: [{ status: "400", title: "Invalid parameter", detail: "Invalid version; valid values are 1_3, 1_4" }] }, 400) : gzipTsv("A\tB\n1\t2\n"),
    );
    const client = await connect("readonly", apple.fn);
    const res: any = await client.callTool({ name: "asc_download_sales_report", arguments: { vendorNumber: "8", frequency: "DAILY", reportType: "SUBSCRIPTION" } });
    expect(res.isError, resultText(res)).toBeFalsy();
    expect(apple.calls.map((c) => c.url.searchParams.get("filter[version]"))).toEqual([null, "1_4"]);
  });

  it("doesn't retry an explicit version or an unrelated error", async () => {
    const apple = mockFetch(() => json({ errors: [{ status: "400", title: "Invalid", detail: "version 9_9 is not valid" }] }, 400));
    const client = await connect("readonly", apple.fn);
    await client.callTool({ name: "asc_download_sales_report", arguments: { vendorNumber: "8", frequency: "DAILY", version: "9_9" } });
    expect(apple.calls).toHaveLength(1);

    const other = mockFetch(() => json({ errors: [{ status: "404", title: "Not found", detail: "There were no sales for the date specified." }] }, 404));
    const c2 = await connect("readonly", other.fn);
    const res: any = await c2.callTool({ name: "asc_download_sales_report", arguments: { vendorNumber: "8", frequency: "DAILY" } });
    expect(res.isError).toBe(true);
    expect(other.calls).toHaveLength(1);
  });

  it("falls back to the documented version when Apple names none", () => {
    expect(reportVersionFor("SALES", "A version is required")).toBe("1_0");
    expect(reportVersionFor("SUBSCRIBER", "version missing")).toBe("1_4");
  });
});
