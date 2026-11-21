/**
 * Role → permission matrix (PRD §2). Used by the UI (what to show) and by every server
 * action (what to allow). The database enforces the same boundaries independently
 * through RLS; this is the second, application-level check (ADR-0002).
 */
export const ROLES = ['owner', 'chief_accountant', 'accountant', 'payroll', 'read_only'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Собственик',
  chief_accountant: 'Главен счетоводител',
  accountant: 'Оперативен счетоводител',
  payroll: 'ТРЗ',
  read_only: 'Само четене',
};

export type Permission =
  | 'team.manage' // invite, change roles, grant company access
  | 'audit.view'
  | 'company.create'
  | 'company.edit'
  | 'period.lock'
  | 'accounting.view'
  | 'accounting.post'
  | 'payroll.view'
  | 'payroll.edit';

const MATRIX: Record<Role, readonly Permission[]> = {
  owner: [
    'team.manage',
    'audit.view',
    'company.create',
    'company.edit',
    'period.lock',
    'accounting.view',
    'accounting.post',
    'payroll.view',
    'payroll.edit',
  ],
  chief_accountant: [
    'company.create',
    'company.edit',
    'period.lock',
    'accounting.view',
    'accounting.post',
  ],
  accountant: ['accounting.view', 'accounting.post'],
  payroll: ['payroll.view', 'payroll.edit'],
  read_only: ['accounting.view'],
};

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

export function can(role: Role | null | undefined, permission: Permission): boolean {
  return role ? MATRIX[role].includes(permission) : false;
}
