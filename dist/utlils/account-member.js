/** Firebase UIDs can be object-prototype names; only stored, valid roles grant access. */
export function memberRole(members, uid) {
    if (!members || typeof members !== "object" || !Object.prototype.hasOwnProperty.call(members, uid))
        return undefined;
    const role = members[uid]?.role;
    return role === "owner" || role === "editor" || role === "viewer" ? role : undefined;
}
