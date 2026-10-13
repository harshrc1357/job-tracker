"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { detachEmail, mergeApplications, resolveReview, setStage, splitApplication, type ReviewChoice } from "@/lib/link/actions";
import { STAGES, type Stage } from "@/lib/link/types";

// The middleware already requires the owner's session for every route that renders the
// forms posting here, and server actions are POSTs to those same routes, so no separate
// auth check is needed. Inputs are still validated: a form field is user input.

const int = (v: FormDataEntryValue | null): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error("bad id");
  return n;
};

function refresh(appId?: number) {
  revalidatePath("/", "layout");
  if (appId) revalidatePath(`/applications/${appId}`);
}

export async function setStageAction(form: FormData) {
  const appId = int(form.get("appId"));
  const stage = String(form.get("stage"));
  if (stage !== "Rejected" && !(STAGES as readonly string[]).includes(stage)) throw new Error("bad stage");
  await setStage(db, appId, stage as Stage | "Rejected");
  refresh(appId);
}

export async function detachEmailAction(form: FormData) {
  const appId = int(form.get("appId"));
  await detachEmail(db, int(form.get("emailId")));
  refresh(appId);
  // The application may have been deleted if that was its only email.
  redirect("/review");
}

export async function splitAction(form: FormData) {
  const appId = int(form.get("appId"));
  const emailIds = form.getAll("emailId").map(int);
  if (emailIds.length === 0) return;
  const role = String(form.get("role") ?? "").trim() || null;
  const created = await splitApplication(db, appId, emailIds, { role });
  refresh(appId);
  redirect(`/applications/${created}`);
}

export async function mergeAction(form: FormData) {
  const fromId = int(form.get("appId"));
  const intoId = int(form.get("intoId"));
  await mergeApplications(db, fromId, intoId);
  refresh(intoId);
  redirect(`/applications/${intoId}`);
}

export async function resolveReviewAction(form: FormData) {
  const itemId = int(form.get("itemId"));
  const type = String(form.get("choice"));
  let choice: ReviewChoice;
  if (type === "attach") choice = { type: "attach", applicationId: int(form.get("applicationId")) };
  else if (type === "new") choice = { type: "new" };
  else if (type === "ignore") choice = { type: "ignore" };
  else throw new Error("bad choice");
  await resolveReview(db, itemId, choice);
  refresh();
}
