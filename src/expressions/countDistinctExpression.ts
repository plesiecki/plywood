/*
 * Copyright 2016-2020 Imply Data, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Dataset, PlywoodValue } from '../datatypes/index';
import { SQLDialect } from '../dialect/baseDialect';

import {
  ChainableUnaryExpression,
  Expression,
  ExpressionJS,
  ExpressionValue,
} from './baseExpression';
import { Aggregate } from './mixins/aggregate';
import { RefExpression } from './refExpression';

export class CountDistinctExpression extends ChainableUnaryExpression implements Aggregate {
  static op = 'CountDistinct';
  static fromJS(parameters: ExpressionJS): CountDistinctExpression {
    return new CountDistinctExpression(ChainableUnaryExpression.jsToValue(parameters));
  }

  constructor(parameters: ExpressionValue) {
    super(parameters, dummyObject);
    this._ensureOp('countDistinct');
    this._checkOperandTypes('DATASET');
    this.type = 'NUMBER';
  }

  protected _calcChainableUnaryHelper(operandValue: any, _expressionValue: any): PlywoodValue {
    return operandValue ? (operandValue as Dataset).countDistinct(this.expression) : null;
  }

  protected _getSQLChainableUnaryHelper(
    dialect: SQLDialect,
    operandSQL: string,
    expressionSQL: string,
  ): string {
    const { expression } = this;
    return dialect.countDistinctExpression(
      dialect.aggregateFilterIfNeeded(operandSQL, expressionSQL),
      expression instanceof RefExpression ? expression.name : undefined,
    );
  }
}

Expression.applyMixins(CountDistinctExpression, [Aggregate]);
Expression.register(CountDistinctExpression);
