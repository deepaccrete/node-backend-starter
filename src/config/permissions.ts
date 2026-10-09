/**
 * Roles and permissions. The backend owns this table: the login response sends
 * the signed-in user's permission list, and the frontend only checks that list.
 *
 * Code checks PERMISSIONS, never role names, so a role gains or loses a
 * capability by editing this table only.
 */

export const ROLES = ['ADMIN', 'GM', 'ZM', 'RM', 'ASM'] as const;
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
