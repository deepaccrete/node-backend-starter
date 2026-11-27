/**
 * Roles and permissions. The backend owns this table: the login response sends
 * the signed-in user's permission list, and the frontend only checks that list.
 *
 * Code checks PERMISSIONS, never role names, so a role gains or loses a
 * capability by editing this table only.
 */

// SUPERADMIN signs in through this API (usermaster). The others sign in through
// the .NET team's central user management (CUM) API.
export const ROLES = ['SUPERADMIN', 'ADMIN', 'GM', 'ZM', 'RM', 'ASM'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
    'dashboard:view',
    'reports:view',
    'reports:export',
    'plans:upload',
    'masters:manage',
    'users:manage',
    'samples:view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const MANAGER_PERMISSIONS: readonly Permission[] = [
    'dashboard:view',
    'reports:view',
    'reports:export',
    'samples:view',
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
    SUPERADMIN: PERMISSIONS,
    ADMIN: PERMISSIONS,
    GM: MANAGER_PERMISSIONS,
    ZM: MANAGER_PERMISSIONS,
    RM: MANAGER_PERMISSIONS,
    ASM: MANAGER_PERMISSIONS,
};

export function isRole(value: unknown): value is Role {
    return ROLES.some((role) => role === value);
}

export function permissionsFor(role: Role): Permission[] {
    return [...ROLE_PERMISSIONS[role]];
}

/**
 * Who a role reports to, one level up. Null: the role reports to no one in TPJP.
 * Proposed from the Scope of Work (ASM → RM → ZM → GM); Lotte confirms the final
 * structure during design.
 */
export const REPORTS_TO_ROLE: Record<Role, Role | null> = {
    SUPERADMIN: null,
    ADMIN: null,
    GM: null,
    ZM: 'GM',
    RM: 'ZM',
    ASM: 'RM',
};
