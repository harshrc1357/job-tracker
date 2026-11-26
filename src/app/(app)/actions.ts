"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { detachEmail, mergeApplications, resolveReview, setStage, splitApplication, type ReviewChoice } from "@/lib/link/actions";
import { STAGES, type Stage } from "@/lib/link/types";
import { parseId } from "@/lib/parseId";
import { requireOwner } from "@/lib/requireOwner";

// The middleware keeps strangers off the pages that render these forms, but a server
// action is a POST that anyone who knows its id can send. So every action asks for the
// owner's session itself, first, and treats every form field as user input.

const int = (v: FormDataEntryValue | null): number => {
  const id = parseId(v);
  if (id === null) throw new Error("bad id");
  return id;
};

function refresh(appId?: number) {
  revalidatePath("/", "layout");
  if (appId) revalidatePath(`/applications/${appId}`);
}

export async function setStageAction(form: FormData) {
  await requireOwner();
  const appId = int(form.get("appId"));
  const stage = String(form.get("stage"));
  if (stage !== "Rejected" && !(STAGES as readonly string[]).includes(stage)) throw new Error("bad stage");
  await setStage(db, appId, stage as Stage | "Rejected");
  refresh(appId);
}

export async function detachEmailAction(form: FormData) {
  await requireOwner();
  const appId = int(form.get("appId"));
  await detachEmail(db, int(form.get("emailId")));
  refresh(appId);
  // The application may have been deleted if that was its only email.
  redirect("/review");
}

// Form fields have no size limit of their own. These match the longest role the classifier
// stores and leave far more ids than one application ever holds.
const MAX_ROLE_CHARS = 200;
const MAX_SPLIT_EMAILS = 500;

export async function splitAction(form: FormData) {
  await requireOwner();
  const appId = int(form.get("appId"));
  const rawIds = form.getAll("emailId");
  if (rawIds.length > MAX_SPLIT_EMAILS) throw new Error("too many emails");
  const emailIds = rawIds.map(int);
  if (emailIds.length === 0) return;
  const role = String(form.get("role") ?? "").trim() || null;
  if (role !== null && role.length > MAX_ROLE_CHARS) throw new Error("bad role");
  const created = await splitApplication(db, appId, emailIds, { role });
  refresh(appId);
  redirect(`/applications/${created}`);
}

export async function mergeAction(form: FormData) {
  await requireOwner();
  const fromId = int(form.get("appId"));
  const intoId = int(form.get("intoId"));
  await mergeApplications(db, fromId, intoId);
  refresh(intoId);
  redirect(`/applications/${intoId}`);
}

export async function resolveReviewAction(form: FormData) {
  await requireOwner();
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
