import * as budgets from 'aws-cdk-lib/aws-budgets';
import { Construct } from 'constructs';

export interface CostGuardProps {
  readonly monthlyLimitUsd: number;
  readonly notifyEmail: string;
}

/**
 * The first two budgets per account are free. This is the backstop for the
 * whole cost model: if anything in this stack starts billing, it says so before
 * the month ends.
 */
export class CostGuard extends Construct {
  constructor(scope: Construct, id: string, props: CostGuardProps) {
    super(scope, id);

    new budgets.CfnBudget(this, 'Monthly', {
      budget: {
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: props.monthlyLimitUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [{
        notification: {
          notificationType: 'FORECASTED',
          comparisonOperator: 'GREATER_THAN',
          threshold: 100,
          thresholdType: 'PERCENTAGE',
        },
        subscribers: [{ subscriptionType: 'EMAIL', address: props.notifyEmail }],
      }],
    });
  }
}
