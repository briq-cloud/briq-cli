import { z } from 'zod';
import { Size } from './sizes.js';

export const Plan = z.enum(['hobby', 'pro', 'team']);
export type Plan = z.infer<typeof Plan>;

/** The plan every new team starts on. */
export const DEFAULT_PLAN: Plan = 'hobby';

export interface PlanLimits {
  /** What people read: "Hobby", "Pro", "Team". */
  label: string;
  /** Live sandboxes and services across all credentials in one team; includes lifecycle transitions. */
  maxConcurrentBriqs: number;
  /**
   * How many briqs one key or connected client may have live when nobody set a limit for it. It
   * follows the team's plan: after an upgrade the same key runs more.
   */
  defaultKeyConcurrentBriqs: number;
  /** Requests to create a sandbox, service or fork that one key may make in a minute. */
  createsPerMinute: number;
  /** API requests that one key may make in a minute, command executions included. */
  requestsPerMinute: number;
  /** Command streams (shell and exec WebSockets) a team may hold open at once. */
  maxExecStreams: number;
  /** Memory in GB summed over the team's live sandboxes and services; stopped and sleeping ones do not count. */
  maxMemoryGb: number;
  /** People in one team, the owner included. A pending invitation holds a seat. */
  maxMembers: number;
  /** The sizes a briq may be created at. */
  sizes: readonly Size[];
  /** Sizes the plan opens once the team has a card on file, on top of `sizes`. */
  cardSizes: readonly Size[];
  /** Volume gigabytes a team may hold at once, running and stopped briqs together. */
  maxDiskGb: number;
  /**
   * Volume gigabytes held at no charge; a team holding more pays `DISK_CENTS_PER_GB_MONTH` for
   * each gigabyte above it, up to `maxDiskGb`. Equal to `maxDiskGb` where disk is never charged.
   */
  includedDiskGb: number;
  /**
   * Whether a briq may be always on (`sleep: "never"`). Without it, every briq sleeps after at most
   * the environment's longest window without use. A team that moves down keeps the always-on
   * briqs it has.
   */
  alwaysOn: boolean;
  /** Whether a briq may have `/dev/kvm` (`kvm: true` in its spec). */
  kvm: boolean;
  /**
   * The subscription, euro cents a month before tax; 0 is a free plan. It is also the usage the
   * plan includes each month: what is left of it at the end of the period expires.
   */
  monthlyCents: number;
}

/** Euro cents per gigabyte-month of volume disk held above a plan's `includedDiskGb`. */
export const DISK_CENTS_PER_GB_MONTH = 12;

/** Hours in the month disk is priced by: the rate per gigabyte-hour is the monthly one over this. */
export const DISK_HOURS_PER_MONTH = 730;

/** What each plan allows, as https://briq.cloud/pricing shows it. Each team has its own plan. */
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  hobby: {
    label: 'Hobby',
    maxConcurrentBriqs: 5,
    createsPerMinute: 30,
    requestsPerMinute: 300,
    maxExecStreams: 16,
    defaultKeyConcurrentBriqs: 5,
    maxMemoryGb: 16,
    maxMembers: 1,
    sizes: ['pico', 'micro', 'nano', 'small', 'medium'],
    cardSizes: ['large'],
    maxDiskGb: 10,
    includedDiskGb: 10,
    alwaysOn: false,
    kvm: false,
    monthlyCents: 0,
  },
  pro: {
    label: 'Pro',
    maxConcurrentBriqs: 50,
    createsPerMinute: 50,
    requestsPerMinute: 1500,
    maxExecStreams: 50,
    defaultKeyConcurrentBriqs: 50,
    maxMemoryGb: 80,
    maxMembers: 5,
    sizes: Size.options,
    cardSizes: [],
    maxDiskGb: 250,
    includedDiskGb: 100,
    alwaysOn: true,
    kvm: true,
    monthlyCents: 2000,
  },
  team: {
    label: 'Team',
    maxConcurrentBriqs: 200,
    createsPerMinute: 200,
    requestsPerMinute: 5000,
    maxExecStreams: 200,
    defaultKeyConcurrentBriqs: 200,
    maxMemoryGb: 256,
    maxMembers: 20,
    sizes: Size.options,
    cardSizes: [],
    maxDiskGb: 1000,
    includedDiskGb: 500,
    alwaysOn: true,
    kvm: true,
    monthlyCents: 10_000,
  },
};
