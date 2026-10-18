import { z } from 'zod';
import { Size } from './sizes.js';

export const Plan = z.enum(['hobby', 'pro', 'team']);
export type Plan = z.infer<typeof Plan>;

/** The plan every new team starts on. */
export const DEFAULT_PLAN: Plan = 'hobby';

export interface PlanLimits {
  /** What people read: "Hobby", "Pro", "Team". */
  label: string;
  /** Agents one team may have at once: API keys and signed-in MCP clients, revoked ones aside. */
  maxAgents: number;
  /** People in one team, the owner included. A pending invitation holds a seat. */
  maxMembers: number;
  /** The sizes a briq may be created at. */
  sizes: readonly Size[];
  /** Sizes the plan opens once the team has a card on file, on top of `sizes`. */
  cardSizes: readonly Size[];
  /** Volume gigabytes a team may hold at once, running and stopped briqs together. */
  maxDiskGb: number;
  /**
   * Whether a briq may be always on (`sleep: "never"`). Without it, every briq sleeps after at most
   * the environment's longest window without use. A team that moves down keeps the always-on
   * briqs it has.
   */
  alwaysOn: boolean;
  /**
   * The subscription, euro cents a month before tax; 0 is a free plan. It is also the usage the
   * plan includes each month: what is left of it at the end of the period expires.
   */
  monthlyCents: number;
}

/** What each plan allows, as https://briq.cloud/pricing shows it. Each team has its own plan. */
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  hobby: {
    label: 'Hobby',
    maxAgents: 3,
    maxMembers: 1,
    sizes: ['nano', 'small', 'medium'],
    cardSizes: ['large'],
    maxDiskGb: 10,
    alwaysOn: false,
    monthlyCents: 0,
  },
  pro: {
    label: 'Pro',
    maxAgents: 25,
    maxMembers: 5,
    sizes: Size.options,
    cardSizes: [],
    maxDiskGb: 250,
    alwaysOn: true,
    monthlyCents: 2000,
  },
  team: {
    label: 'Team',
    maxAgents: 100,
    maxMembers: 20,
    sizes: Size.options,
    cardSizes: [],
    maxDiskGb: 1000,
    alwaysOn: true,
    monthlyCents: 10_000,
  },
};
