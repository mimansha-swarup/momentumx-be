import { memberRole } from "../../../src/utlils/account-member";
import { isDocumentId } from "../../../src/utlils/firestore-id";

it.each(["constructor", "toString", "__proto__"])("never grants inherited membership to %s", uid => {
  expect(memberRole({}, uid)).toBeUndefined();
  expect(memberRole({ [uid]: { role: "editor" } }, uid)).toBe("editor");
  expect(memberRole({ [uid]: { role: "admin" } }, uid)).toBeUndefined();
});
it("keeps Firestore document-id restrictions separate from membership", () => {
  expect(isDocumentId("constructor")).toBe(true);
  expect(isDocumentId("toString")).toBe(true);
  expect(isDocumentId("__proto__")).toBe(false);
});
