import { describe, expect, it } from 'vitest';
import { can, ROLES } from './permissions';

describe('permission matrix (PRD §2)', () => {
  it('only the owner manages the team and reads the audit log', () => {
    for (const r of ROLES) {
      expect(can(r, 'team.manage'), r).toBe(r === 'owner');
      expect(can(r, 'audit.view'), r).toBe(r === 'owner');
    }
  });

  it('only owner and chief accountant lock periods and create companies', () => {
    for (const r of ROLES) {
      const expected = r === 'owner' || r === 'chief_accountant';
      expect(can(r, 'period.lock'), r).toBe(expected);
      expect(can(r, 'company.create'), r).toBe(expected);
    }
  });

  it('salary data is limited to payroll and the owner', () => {
    for (const r of ROLES) {
      expect(can(r, 'payroll.view'), r).toBe(r === 'payroll' || r === 'owner');
    }
  });

  it('read-only can view accounting but never post', () => {
    expect(can('read_only', 'accounting.view')).toBe(true);
    expect(can('read_only', 'accounting.post')).toBe(false);
  });

  it('payroll does not see general accounting (PRD: only the payroll module)', () => {
    expect(can('payroll', 'accounting.view')).toBe(false);
  });

  it('no role means no permission', () => {
    expect(can(null, 'accounting.view')).toBe(false);
    expect(can(undefined, 'accounting.view')).toBe(false);
  });
});
