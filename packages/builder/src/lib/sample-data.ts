/**
 * Starter data a designer can bind to straight away. This is the USER's sample
 * content inside their own design (editable in the Data panel), never data the
 * console shows as its own.
 */
export const SAMPLE_CUSTOMERS = JSON.stringify([
  { id: 1, name: 'Ada Lovelace', email: 'ada@analytical.io', company: 'Analytical Engines', status: 'Active', plan: 'Enterprise' },
  { id: 2, name: 'Grace Hopper', email: 'grace@cobol.dev', company: 'Compiler Co', status: 'Active', plan: 'Team' },
  { id: 3, name: 'Alan Turing', email: 'alan@enigma.org', company: 'Bletchley Labs', status: 'Trial', plan: 'Team' },
  { id: 4, name: 'Katherine Johnson', email: 'katherine@orbit.space', company: 'Orbit Dynamics', status: 'Active', plan: 'Starter' },
  { id: 5, name: 'Linus Torvalds', email: 'linus@kernel.dev', company: 'Kernel Works', status: 'Paused', plan: 'Starter' },
], null, 2);

export const SAMPLE_ORDERS = JSON.stringify([
  { id: 'ORD-1042', customer: 'Ada Lovelace', total: '$1,280.00', status: 'Paid', date: '2026-10-14' },
  { id: 'ORD-1041', customer: 'Grace Hopper', total: '$342.50', status: 'Pending', date: '2026-10-13' },
  { id: 'ORD-1040', customer: 'Alan Turing', total: '$89.99', status: 'Refunded', date: '2026-10-12' },
  { id: 'ORD-1039', customer: 'Katherine Johnson', total: '$2,410.00', status: 'Paid', date: '2026-10-11' },
], null, 2);
