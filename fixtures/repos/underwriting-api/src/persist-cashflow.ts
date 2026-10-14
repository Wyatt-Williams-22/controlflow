/**
 * Writes a derived cash-flow summary for an underwriting application.
 * The row has no owner and no retention classification.
 */

export type CashFlowSummary = {
  applicationId: string;
  monthlyNetInflow: number;
  capturedOn: string;
};

export function persistCashFlowSummary(summary: CashFlowSummary): void {
  insert("cash_flow_summary", {
    application_id: summary.applicationId,
    monthly_net_inflow: summary.monthlyNetInflow,
    captured_on: summary.capturedOn,
  });
}

function insert(table: string, row: Record<string, string | number>): void {
  void table;
  void row;
}
