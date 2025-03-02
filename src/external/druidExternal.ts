/*
 * Copyright 2012-2015 Metamarkets Group Inc.
 * Copyright 2015-2020 Imply Data, Inc.
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

import * as Druid from 'druid.d.ts';
import * as hasOwnProp from 'has-own-prop';
import { PlywoodRequester } from 'plywood-base-api';
import { Transform } from 'readable-stream';
import * as toArray from 'stream-to-array';

import {
  AttributeInfo,
  Attributes,
  Datum,
  PlywoodRange,
  Range,
  Set,
  TimeRange,
} from '../datatypes/index';
import {
  $,
  ApplyExpression,
  CardinalityExpression,
  ChainableExpression,
  ChainableUnaryExpression,
  CountDistinctExpression,
  CountExpression,
  CustomAggregateExpression,
  Expression,
  FallbackExpression,
  FilterExpression,
  InExpression,
  IsExpression,
  MatchExpression,
  MaxExpression,
  MinExpression,
  NumberBucketExpression,
  r,
  RefExpression,
  SortExpression,
  SplitExpression,
  Splits,
  TimeBucketExpression,
  TimeFloorExpression,
  TimePartExpression,
} from '../expressions/index';
import { dictEqual, ExtendableError, nonEmptyLookup, shallowCopy } from '../helper/utils';

import {
  External,
  ExternalJS,
  ExternalValue,
  Inflater,
  IntrospectionDepth,
  QueryAndPostTransform,
  QuerySelection,
} from './baseExternal';
import {
  AggregationsAndPostAggregations,
  DruidAggregationBuilder,
} from './utils/druidAggregationBuilder';
import { DruidExpressionBuilder } from './utils/druidExpressionBuilder';
import { DruidExtractionFnBuilder } from './utils/druidExtractionFnBuilder';
import { DruidFilterBuilder } from './utils/druidFilterBuilder';
import { DruidHavingFilterBuilder } from './utils/druidHavingFilterBuilder';
import { CustomDruidAggregations, CustomDruidTransforms } from './utils/druidTypes';

export class InvalidResultError extends ExtendableError {
  public result: any;

  constructor(message: string, result: any) {
    super(message);
    this.result = result;
  }
}

export interface ParsedResplitAgg {
  resplitAgg: ChainableExpression;
  resplitApply: ApplyExpression;
  resplitSplit: SplitExpression;
}

function expressionNeedsNumericSort(ex: Expression): boolean {
  const type = ex.type;
  return type === 'NUMBER' || type === 'NUMBER_RANGE';
}

function simpleJSONEqual(a: any, b: any): boolean {
  return JSON.stringify(a) === JSON.stringify(b); // ToDo: fill this in;
}

function getFilterSubExpression(expression: Expression): FilterExpression | undefined {
  let filterSubExpression: FilterExpression | undefined;

  expression.some(ex => {
    if (ex instanceof FilterExpression) {
      if (!filterSubExpression) {
        filterSubExpression = ex;
      }
      return true;
    }
    return null;
  });

  return filterSubExpression;
}

export interface GranularityInflater {
  granularity: Druid.Granularity;
  inflater: Inflater;
}

export interface DimensionInflater {
  virtualColumn?: Druid.VirtualColumn;
  dimension: Druid.DimensionSpec;
  inflater?: Inflater;
}

export interface DimensionInflaterHaving extends DimensionInflater {
  having?: Expression;
}

export interface DruidSplit {
  queryType: string;
  timestampLabel?: string;
  virtualColumns?: Druid.VirtualColumn[];
  granularity: Druid.Granularity | string;
  dimension?: Druid.DimensionSpec;
  dimensions?: Druid.DimensionSpec[];
  leftoverHavingFilter?: Expression;
  postTransform: Transform;
}

export class DruidExternal extends External {
  static engine = 'druid';
  static type = 'DATASET';
  static TIME_ATTRIBUTE = '__time';

  static SELECT_MAX_LIMIT = 10000;

  static fromJS(parameters: ExternalJS, requester: PlywoodRequester<any>): DruidExternal {
    const value: ExternalValue = External.jsToValue(parameters, requester);
    value.timeAttribute = parameters.timeAttribute;
    value.customAggregations = parameters.customAggregations || {};
    value.customTransforms = parameters.customTransforms || {};
    value.allowEternity = Boolean(parameters.allowEternity);
    value.allowSelectQueries = Boolean(parameters.allowSelectQueries);
    value.exactResultsOnly = Boolean(parameters.exactResultsOnly);
    value.querySelection = parameters.querySelection;
    value.context = parameters.context;
    return new DruidExternal(value);
  }

  static getSourceList(requester: PlywoodRequester<any>): Promise<string[]> {
    return toArray(requester({ query: { queryType: 'sourceList' } })).then(sourcesArray => {
      const sources = sourcesArray[0];
      if (!Array.isArray(sources))
        throw new InvalidResultError('invalid sources response', sources);
      return sources.sort();
    });
  }

  static getVersion(requester: PlywoodRequester<any>): Promise<string> {
    return toArray(
      requester({
        query: {
          queryType: 'status',
        },
      }),
    ).then(res => {
      return res[0].version;
    });
  }

  static isTimestampCompatibleSort(sort: SortExpression, label: string): boolean {
    if (!sort) return true;

    const sortExpression = sort.expression;
    if (sortExpression instanceof RefExpression) {
      return sortExpression.name === label;
    }

    return false;
  }

  static timeBoundaryPostTransformFactory(applies?: ApplyExpression[]) {
    return new Transform({
      objectMode: true,
      transform: (d: Datum, encoding, callback) => {
        if (applies) {
          const datum: Datum = {};
          for (const apply of applies) {
            const name = apply.name;
            if (typeof d === 'string') {
              datum[name] = new Date(d);
            } else {
              if (apply.expression.op === 'max') {
                datum[name] = new Date((d['maxIngestedEventTime'] || d['maxTime']) as string);
              } else {
                datum[name] = new Date(d['minTime'] as string);
              }
            }
          }

          callback(null, {
            type: 'datum',
            datum,
          });
        } else {
          callback(null, {
            type: 'value',
            value: new Date((d['maxIngestedEventTime'] || d['maxTime'] || d['minTime']) as string),
          });
        }
      },
    });
  }

  static generateMaker(aggregation: Druid.Aggregation): Expression {
    if (!aggregation) return null;
    let { type, fieldName } = aggregation;

    // Hacky way to guess at a count
    if (type === 'longSum' && fieldName === 'count') {
      return Expression._.count();
    }

    if (!fieldName) {
      const { fieldNames } = aggregation;
      if (!Array.isArray(fieldNames) || fieldNames.length !== 1) return null;
      fieldName = fieldNames[0];
    }

    const expression = $(fieldName);
    switch (type) {
      case 'count':
        return Expression._.count();

      case 'doubleSum':
      case 'longSum':
        return Expression._.sum(expression);

      case 'javascript': {
        const { fnAggregate, fnCombine } = aggregation;
        if (fnAggregate !== fnCombine || fnCombine.indexOf('+') === -1) return null;
        return Expression._.sum(expression);
      }

      case 'doubleMin':
      case 'longMin':
        return Expression._.min(expression);

      case 'doubleMax':
      case 'longMax':
        return Expression._.max(expression);

      default:
        return null;
    }
  }

  static columnMetadataToRange(columnMetadata: Druid.ColumnMetadata): null | PlywoodRange {
    const { minValue, maxValue } = columnMetadata;
    if (minValue == null || maxValue == null) return null;
    return Range.fromJS({
      start: minValue,
      end: maxValue,
      bounds: '[]',
    });
  }

  static segmentMetadataPostProcess(
    timeAttribute: string,
    res: Druid.SegmentMetadataResults,
  ): Attributes {
    const res0 = res[0];
    if (!res0 || !res0.columns)
      throw new InvalidResultError('malformed segmentMetadata response', res);
    const columns = res0.columns;
    const aggregators = res0.aggregators || {};

    let foundTime = false;
    const attributes: Attributes = [];
    for (const name in columns) {
      if (!hasOwnProp(columns, name)) continue;
      const columnData = columns[name];

      // Error conditions
      if (columnData.errorMessage || columnData.size < 0) continue;

      if (name === DruidExternal.TIME_ATTRIBUTE) {
        attributes.unshift(
          new AttributeInfo({
            name: timeAttribute,
            type: 'TIME',
            nativeType: '__time',
            cardinality: columnData.cardinality,
            range: DruidExternal.columnMetadataToRange(columnData),
          }),
        );
        foundTime = true;
      } else {
        if (name === timeAttribute) continue; // Ignore dimensions and metrics that clash with the timeAttribute name
        const nativeType = columnData.type;
        switch (columnData.type) {
          case 'DOUBLE':
          case 'FLOAT':
          case 'LONG':
            attributes.push(
              new AttributeInfo({
                name,
                type: 'NUMBER',
                nativeType,
                unsplitable: hasOwnProp(aggregators, name),
                maker: DruidExternal.generateMaker(aggregators[name]),
                cardinality: columnData.cardinality,
                range: DruidExternal.columnMetadataToRange(columnData),
              }),
            );
            break;

          case 'STRING':
            attributes.push(
              new AttributeInfo({
                name,
                type: columnData.hasMultipleValues ? 'SET/STRING' : 'STRING',
                nativeType,
                cardinality: columnData.cardinality,
                range: DruidExternal.columnMetadataToRange(columnData),
              }),
            );
            break;

          case 'hyperUnique':
          case 'approximateHistogram':
          case 'thetaSketch':
          case 'HLLSketch':
          case 'quantilesDoublesSketch':
            attributes.push(
              new AttributeInfo({
                name,
                type: 'NULL',
                nativeType,
                unsplitable: true,
              }),
            );
            break;

          default:
            attributes.push(
              new AttributeInfo({
                name,
                type: 'NULL',
                nativeType,
              }),
            );
            break;
        }
      }
    }

    if (!foundTime) {
      throw new Error(`no valid ${DruidExternal.TIME_ATTRIBUTE} in segmentMetadata response`);
    }

    return attributes;
  }

  static async introspectAttributesWithSegmentMetadata(
    dataSource: Druid.DataSource,
    requester: PlywoodRequester<any>,
    timeAttribute: string,
    context: Record<string, any>,
    depth: IntrospectionDepth,
  ): Promise<Attributes> {
    const analysisTypes: string[] = ['aggregators'];
    if (depth === 'deep') {
      analysisTypes.push('cardinality', 'minmax');
    }

    let query: Druid.Query = {
      queryType: 'segmentMetadata',
      dataSource,
      merge: true,
      analysisTypes,
      lenientAggregatorMerge: true,
    };

    if (context) {
      query.context = context;
    }

    const res = await toArray(requester({ query }));
    const attributes = DruidExternal.segmentMetadataPostProcess(timeAttribute, res);

    if (
      depth !== 'shallow' &&
      attributes.length &&
      attributes[0].nativeType === '__time' &&
      !attributes[0].range
    ) {
      try {
        query = {
          queryType: 'timeBoundary',
          dataSource,
        };

        if (context) {
          query.context = context;
        }

        const resTB = await toArray(requester({ query }));
        const resTB0: any = resTB[0];

        attributes[0] = attributes[0].changeRange(
          TimeRange.fromJS({
            start: resTB0.minTime,
            end: resTB0.maxTime,
            bounds: '[]',
          }),
        );
      } catch (e) {
        // Nothing to do, swallow this error
      }
    }

    return attributes;
  }

  /**
   * A paging identifier typically looks like this:
   * { "wikipedia_2012-12-29T00:00:00.000Z_2013-01-10T08:00:00.000Z_2013-01-10T08:13:47.830Z_v9": 4 }
   */
  static movePagingIdentifiers(
    pagingIdentifiers: Druid.PagingIdentifiers,
    increment: number,
  ): Druid.PagingIdentifiers {
    const newPagingIdentifiers: Druid.PagingIdentifiers = {};
    for (const key in pagingIdentifiers) {
      if (!hasOwnProp(pagingIdentifiers, key)) continue;
      newPagingIdentifiers[key] = pagingIdentifiers[key] + increment;
    }
    return newPagingIdentifiers;
  }

  static parseResplitAgg(applyExpression: Expression): ParsedResplitAgg | null {
    const resplitAgg = applyExpression;
    if (!(resplitAgg instanceof ChainableExpression) || !resplitAgg.isAggregate()) return null;

    const resplitApply = resplitAgg.operand;
    if (!(resplitApply instanceof ApplyExpression)) return null;

    const resplitSplit = resplitApply.operand;
    if (!(resplitSplit instanceof SplitExpression)) return null;

    const resplitRefOrFilter = resplitSplit.operand;
    let resplitRef: Expression;
    let effectiveResplitApply: ApplyExpression = resplitApply.changeOperand(Expression._);
    if (resplitRefOrFilter instanceof FilterExpression) {
      resplitRef = resplitRefOrFilter.operand;

      const filterExpression = resplitRefOrFilter.expression;
      effectiveResplitApply = effectiveResplitApply.changeExpression(
        effectiveResplitApply.expression.substitute(ex => {
          if (ex instanceof RefExpression && ex.type === 'DATASET') {
            return ex.filter(filterExpression);
          }
          return null;
        }),
      );
    } else {
      resplitRef = resplitRefOrFilter;
    }

    if (!(resplitRef instanceof RefExpression)) return null;

    return {
      resplitAgg: resplitAgg.changeOperand(Expression._),
      resplitApply: effectiveResplitApply,
      resplitSplit: resplitSplit.changeOperand(Expression._),
    };
  }

  public timeAttribute: string;
  public customAggregations: CustomDruidAggregations;
  public customTransforms: CustomDruidTransforms;
  public allowEternity: boolean;
  public allowSelectQueries: boolean;
  public exactResultsOnly: boolean;
  public querySelection: QuerySelection;
  public context: Record<string, any>;

  constructor(parameters: ExternalValue) {
    super(parameters, dummyObject);
    this._ensureEngine('druid');
    this._ensureMinVersion('0.14.0');
    this.timeAttribute = parameters.timeAttribute || DruidExternal.TIME_ATTRIBUTE;
    this.customAggregations = parameters.customAggregations;
    this.customTransforms = parameters.customTransforms;
    this.allowEternity = parameters.allowEternity;
    this.allowSelectQueries = parameters.allowSelectQueries;
    this.exactResultsOnly = parameters.exactResultsOnly;
    this.querySelection = parameters.querySelection;
    this.context = parameters.context;
  }

  public valueOf(): ExternalValue {
    const value: ExternalValue = super.valueOf();
    value.timeAttribute = this.timeAttribute;
    value.customAggregations = this.customAggregations;
    value.customTransforms = this.customTransforms;
    value.allowEternity = this.allowEternity;
    value.allowSelectQueries = this.allowSelectQueries;
    value.exactResultsOnly = this.exactResultsOnly;
    value.querySelection = this.querySelection;
    value.context = this.context;
    return value;
  }

  public toJS(): ExternalJS {
    const js: ExternalJS = super.toJS();
    if (this.timeAttribute !== DruidExternal.TIME_ATTRIBUTE) js.timeAttribute = this.timeAttribute;
    if (nonEmptyLookup(this.customAggregations)) js.customAggregations = this.customAggregations;
    if (nonEmptyLookup(this.customTransforms)) js.customTransforms = this.customTransforms;
    if (this.allowEternity) js.allowEternity = true;
    if (this.allowSelectQueries) js.allowSelectQueries = true;
    if (this.exactResultsOnly) js.exactResultsOnly = true;
    if (this.querySelection) js.querySelection = this.querySelection;
    if (this.context) js.context = this.context;
    return js;
  }

  public equals(other: DruidExternal | undefined): boolean {
    return (
      super.equals(other) &&
      this.timeAttribute === other.timeAttribute &&
      simpleJSONEqual(this.customAggregations, other.customAggregations) &&
      simpleJSONEqual(this.customTransforms, other.customTransforms) &&
      this.allowEternity === other.allowEternity &&
      this.allowSelectQueries === other.allowSelectQueries &&
      this.exactResultsOnly === other.exactResultsOnly &&
      this.querySelection === other.querySelection &&
      dictEqual(this.context, other.context)
    );
  }

  // -----------------

  public canHandleFilter(filter: FilterExpression): boolean {
    return !filter.expression.some(ex => (ex.isOp('cardinality') ? true : null));
  }

  public canHandleSort(sort: SortExpression): boolean {
    if (this.mode === 'raw') {
      if (sort.refName() !== this.timeAttribute) return false;
      return sort.direction === 'ascending'; // scan queries can only sort ascending
    } else {
      return true;
    }
  }

  // -----------------

  public getQuerySelection(): QuerySelection {
    return this.querySelection || 'any';
  }

  public getDruidDataSource(): Druid.DataSource {
    const source = this.source;
    if (Array.isArray(source)) {
      return {
        type: 'union',
        dataSources: source,
      };
    } else {
      return source;
    }
  }

  // ========= FILTERS =========

  public getTimeAttribute(): string | undefined {
    return this.timeAttribute;
  }

  public splitExpressionToGranularityInflater(
    splitExpression: Expression,
    label: string,
  ): GranularityInflater | null {
    if (this.isTimeRef(splitExpression)) {
      return {
        granularity: 'none',
        inflater: External.timeInflaterFactory(label),
      };
    } else if (
      splitExpression instanceof TimeBucketExpression ||
      splitExpression instanceof TimeFloorExpression
    ) {
      const { operand, duration } = splitExpression;
      const timezone = splitExpression.getTimezone();
      if (this.isTimeRef(operand)) {
        return {
          granularity: {
            type: 'period',
            period: duration.toString(),
            timeZone: timezone.toString(),
          },
          inflater: External.getIntelligentInflater(splitExpression, label),
        };
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // Extraction functions

  // ----------------------------

  public makeOutputName(name: string): string {
    if (name.indexOf('__') === 0) {
      // Starts with __
      return '***' + name;
    }
    return name;
  }

  public topNCompatibleSort(): boolean {
    const { sort } = this;
    if (!sort) return true;

    const refExpression = sort.expression;
    if (refExpression instanceof RefExpression) {
      const sortRefName = refExpression.name;
      const sortApply = this.applies.find(apply => apply.name === sortRefName);
      if (sortApply) {
        // not compatible if there is a filter on time somewhere
        return !sortApply.expression.some(ex => {
          if (ex instanceof FilterExpression) {
            return ex.expression.some(ex => this.isTimeRef(ex) || null);
          }
          return null;
        });
      }
    }

    return true;
  }

  public expressionToDimensionInflater(expression: Expression, label: string): DimensionInflater {
    const freeReferences = expression.getFreeReferences();
    if (freeReferences.length === 0) {
      return {
        dimension: {
          type: 'extraction',
          dimension: DruidExternal.TIME_ATTRIBUTE,
          outputName: this.makeOutputName(label),
          extractionFn: new DruidExtractionFnBuilder(this).expressionToExtractionFn(expression),
        },
        inflater: null,
      };
    }

    const makeExpression: () => DimensionInflater = () => {
      const druidExpression = new DruidExpressionBuilder(this).expressionToDruidExpression(
        expression,
      );
      if (druidExpression === null) {
        throw new Error(`could not convert ${expression} to Druid expression`);
      }

      const outputName = this.makeOutputName(label);
      const outputType = DruidExpressionBuilder.expressionTypeToOutputType(expression.type);
      const inflater = External.getIntelligentInflater(expression, label);

      let dimensionSrcName = outputName;
      let virtualColumn: Druid.VirtualColumn = null;
      if (!(expression instanceof RefExpression)) {
        dimensionSrcName = 'v:' + dimensionSrcName;
        virtualColumn = {
          type: 'expression',
          name: dimensionSrcName,
          expression: druidExpression,
          outputType,
        };
      }

      return {
        virtualColumn,
        dimension: {
          type: 'default',
          dimension: dimensionSrcName,
          outputName,
          outputType,
        },
        inflater,
      };
    };

    function isComplexFallback(expression: Expression) {
      // Check to see if the expression is something like $(...).blah(...).blah(...).fallback($(...))
      if (expression instanceof FallbackExpression) {
        if (!expression.expression.isOp('ref')) return false;
        const myOp = expression.operand;
        return myOp instanceof ChainableExpression && myOp.operand instanceof ChainableExpression;
      }
      return false;
    }

    if (
      freeReferences.length > 1 ||
      expression.some(ex => ex.isOp('then') || null) ||
      isComplexFallback(expression)
    ) {
      return makeExpression();
    }

    const referenceName = freeReferences[0];

    const attributeInfo = this.getAttributesInfo(referenceName);
    if (attributeInfo.unsplitable) {
      throw new Error(
        `can not convert ${expression} to split because it references an un-splitable metric '${referenceName}' which is most likely rolled up.`,
      );
    }

    let extractionFn: Druid.ExtractionFn | null;
    try {
      extractionFn = new DruidExtractionFnBuilder(this).expressionToExtractionFn(expression);
    } catch {
      return makeExpression();
    }

    const simpleInflater = External.getIntelligentInflater(expression, label);

    const dimension: Druid.DimensionSpecFull = {
      type: 'default',
      dimension:
        attributeInfo.name === this.timeAttribute
          ? DruidExternal.TIME_ATTRIBUTE
          : attributeInfo.name,
      outputName: this.makeOutputName(label),
    };
    if (extractionFn) {
      dimension.type = 'extraction';
      dimension.extractionFn = extractionFn;
    }
    if (expression.type === 'NUMBER') {
      dimension.outputType =
        dimension.dimension === DruidExternal.TIME_ATTRIBUTE ? 'LONG' : 'DOUBLE';
    }

    if (
      expression instanceof RefExpression ||
      expression instanceof TimeBucketExpression ||
      expression instanceof TimePartExpression ||
      expression instanceof NumberBucketExpression
    ) {
      return {
        dimension,
        inflater: simpleInflater,
      };
    }

    if (expression instanceof CardinalityExpression) {
      return {
        dimension,
        inflater: External.setCardinalityInflaterFactory(label),
      };
    }

    const effectiveType = Set.unwrapSetType(expression.type);
    if (simpleInflater || effectiveType === 'STRING' || effectiveType === 'NULL') {
      return {
        dimension,
        inflater: simpleInflater,
      };
    }

    throw new Error(`could not convert ${expression} to a Druid dimension`);
  }

  public expressionToDimensionInflaterHaving(
    expression: Expression,
    label: string,
    havingFilter: Expression,
  ): DimensionInflaterHaving {
    const dimensionInflater: DimensionInflaterHaving = this.expressionToDimensionInflater(
      expression,
      label,
    );
    dimensionInflater.having = havingFilter;
    if (expression.type !== 'SET/STRING') return dimensionInflater;

    const { extract, rest } = havingFilter.extractFromAnd(hf => {
      if (hf instanceof ChainableExpression) {
        const hfOp = hf.op;
        const hfOperand = hf.operand;
        if (hfOperand instanceof RefExpression && hfOperand.name === label) {
          if (hfOp === 'match') return true;
          if (hfOp === 'is') return (hf as ChainableUnaryExpression).expression.isOp('literal');
        }
      }
      return false;
    });

    if (extract.equals(Expression.TRUE)) return dimensionInflater;

    if (extract instanceof MatchExpression) {
      return {
        dimension: {
          type: 'regexFiltered',
          delegate: dimensionInflater.dimension,
          pattern: extract.regexp,
        },
        inflater: dimensionInflater.inflater,
        having: rest,
      };
    } else if (extract instanceof IsExpression) {
      const value = extract.expression.getLiteralValue();
      return {
        dimension: {
          type: 'listFiltered',
          delegate: dimensionInflater.dimension,
          values: Set.isSet(value) ? value.elements : [value],
        },
        inflater: dimensionInflater.inflater,
        having: rest,
      };
    } else if (extract instanceof InExpression) {
      return {
        dimension: {
          type: 'listFiltered',
          delegate: dimensionInflater.dimension,
          values: extract.expression.getLiteralValue().elements,
        },
        inflater: dimensionInflater.inflater,
        having: rest,
      };
    }

    return dimensionInflater;
  }

  public splitToDruid(split: SplitExpression): DruidSplit {
    let leftoverHavingFilter = this.havingFilter;
    const selectedAttributes = this.getSelectedAttributes();

    if (this.getQuerySelection() === 'group-by-only' || split.isMultiSplit()) {
      const timestampLabel: string = null;
      const granularity: Druid.Granularity = null;
      const virtualColumns: Druid.VirtualColumn[] = [];
      const dimensions: Druid.DimensionSpec[] = [];
      const inflaters: Inflater[] = [];
      split.mapSplits((name, expression) => {
        // if (!granularity && !this.limit && !this.sort) {
        //   // We have to add !this.limit && !this.sort because of a bug in groupBy sorting
        //   // Remove it when fixed https://github.com/druid-io/druid/issues/1926
        //   let granularityInflater = this.splitExpressionToGranularityInflater(expression, name);
        //   if (granularityInflater) {
        //     timestampLabel = name;
        //     granularity = granularityInflater.granularity;
        //     inflaters.push(granularityInflater.inflater);
        //     return;
        //   }
        // }

        const { virtualColumn, dimension, inflater, having } =
          this.expressionToDimensionInflaterHaving(expression, name, leftoverHavingFilter);
        leftoverHavingFilter = having;
        if (virtualColumn) virtualColumns.push(virtualColumn);
        dimensions.push(dimension);
        if (inflater) {
          inflaters.push(inflater);
        }
      });
      return {
        queryType: 'groupBy',
        virtualColumns,
        dimensions: dimensions,
        timestampLabel,
        granularity: granularity || 'all',
        leftoverHavingFilter,
        postTransform: External.postTransformFactory(
          inflaters,
          selectedAttributes,
          split.mapSplits(name => name),
          null,
        ),
      };
    }

    const splitExpression = split.firstSplitExpression();
    const label = split.firstSplitName();

    // Can it be a time series?
    if (
      !this.limit &&
      DruidExternal.isTimestampCompatibleSort(this.sort, label) &&
      leftoverHavingFilter.equals(Expression.TRUE)
    ) {
      const granularityInflater = this.splitExpressionToGranularityInflater(splitExpression, label);
      if (granularityInflater) {
        return {
          queryType: 'timeseries',
          granularity: granularityInflater.granularity,
          leftoverHavingFilter,
          timestampLabel: label,
          postTransform: External.postTransformFactory(
            [granularityInflater.inflater],
            selectedAttributes,
            [label],
            null,
          ),
        };
      }
    }

    const dimensionInflater = this.expressionToDimensionInflaterHaving(
      splitExpression,
      label,
      leftoverHavingFilter,
    );
    leftoverHavingFilter = dimensionInflater.having;

    const inflaters = [dimensionInflater.inflater].filter(Boolean);
    if (
      leftoverHavingFilter.equals(Expression.TRUE) && // There is no leftover having filter
      (this.limit || split.maxBucketNumber() < 1000) && // There is a limit (or the split range is limited)
      !this.exactResultsOnly && // We do not care about exact results
      this.topNCompatibleSort() && // Is this sort Kosher for topNs
      this.getQuerySelection() === 'any' // We allow any query
    ) {
      return {
        queryType: 'topN',
        virtualColumns: dimensionInflater.virtualColumn ? [dimensionInflater.virtualColumn] : null,
        dimension: dimensionInflater.dimension,
        granularity: 'all',
        leftoverHavingFilter,
        timestampLabel: null,
        postTransform: External.postTransformFactory(inflaters, selectedAttributes, [label], null),
      };
    }

    return {
      queryType: 'groupBy',
      virtualColumns: dimensionInflater.virtualColumn ? [dimensionInflater.virtualColumn] : null,
      dimensions: [dimensionInflater.dimension],
      granularity: 'all',
      leftoverHavingFilter,
      timestampLabel: null,
      postTransform: External.postTransformFactory(inflaters, selectedAttributes, [label], null),
    };
  }

  public isMinMaxTimeExpression(applyExpression: Expression): boolean {
    if (applyExpression instanceof MinExpression || applyExpression instanceof MaxExpression) {
      return this.isTimeRef(applyExpression.expression);
    } else {
      return false;
    }
  }

  public getTimeBoundaryQueryAndPostTransform(): QueryAndPostTransform<Druid.Query> {
    const { mode, context } = this;
    const druidQuery: Druid.Query = {
      queryType: 'timeBoundary',
      dataSource: this.getDruidDataSource(),
    };

    if (context) {
      druidQuery.context = context;
    }

    let applies: ApplyExpression[] = null;
    if (mode === 'total') {
      applies = this.applies;
      if (applies.length === 1) {
        const loneApplyExpression = applies[0].expression;
        // Max time only
        druidQuery.bound = (loneApplyExpression as ChainableUnaryExpression).op + 'Time';
        // druidQuery.queryType = "dataSourceMetadata";
      }
    } else if (mode === 'value') {
      const { valueExpression } = this;
      druidQuery.bound = (valueExpression as ChainableUnaryExpression).op + 'Time';
    } else {
      throw new Error(`invalid mode '${mode}' for timeBoundary`);
    }

    return {
      query: druidQuery,
      context: { timestamp: null },
      postTransform: DruidExternal.timeBoundaryPostTransformFactory(applies),
    };
  }

  public nestedGroupByIfNeeded(): QueryAndPostTransform<Druid.Query> | null {
    const divvyUpNestedSplitExpression = (
      splitExpression: Expression,
      intermediateName: string,
    ): { inner: Expression; outer: Expression } => {
      if (
        splitExpression instanceof TimeBucketExpression ||
        splitExpression instanceof NumberBucketExpression
      ) {
        return {
          inner: splitExpression,
          outer: splitExpression.changeOperand($(intermediateName)),
        };
      } else {
        return {
          inner: splitExpression,
          outer: $(intermediateName),
        };
      }
    };

    const { applies, split } = this;
    const effectiveApplies = applies
      ? applies
      : [Expression._.apply('__VALUE__', this.valueExpression)];

    // Check for early exit condition - if there are no applies with splits in them then there is nothing to do.
    if (
      !effectiveApplies.some(apply => {
        return apply.expression.some(ex => (ex instanceof SplitExpression ? true : null));
      })
    )
      return null;

    // Split up applies
    let globalResplitSplit: SplitExpression = null;
    const outerAttributes: Attributes = [];
    const innerApplies: ApplyExpression[] = [];
    const outerApplies = effectiveApplies.map((apply, i) => {
      let c = 0;
      return apply.changeExpression(
        apply.expression.substitute(ex => {
          if (ex.isAggregate()) {
            const resplit = DruidExternal.parseResplitAgg(ex);
            if (resplit) {
              if (globalResplitSplit) {
                if (!globalResplitSplit.equals(resplit.resplitSplit))
                  throw new Error('all resplit aggregators must have the same split');
              } else {
                globalResplitSplit = resplit.resplitSplit;
              }

              const resplitApply = resplit.resplitApply;
              const oldName = resplitApply.name;
              const newName = oldName + '_' + i;

              innerApplies.push(
                resplitApply
                  .changeName(newName)
                  .changeExpression(resplitApply.expression.setOption('forceFinalize', true)),
              );
              outerAttributes.push(AttributeInfo.fromJS({ name: newName, type: 'NUMBER' }));

              let resplitAggWithUpdatedNames = resplit.resplitAgg.substitute(ex => {
                if (ex instanceof RefExpression && ex.name === oldName) {
                  return ex.changeName(newName);
                }
                return null;
              }) as ChainableExpression;

              // If there is a filter defined on the inner agg then we need to filter the outer aggregate to only the buckets that have a non-zero count with said filter.
              const filterExpression = getFilterSubExpression(resplit.resplitApply.expression);
              if (filterExpression) {
                const definedFilterName = newName + '_def';
                innerApplies.push($('_').apply(definedFilterName, filterExpression.count()));
                outerAttributes.push(
                  AttributeInfo.fromJS({ name: definedFilterName, type: 'NUMBER' }),
                );
                resplitAggWithUpdatedNames = resplitAggWithUpdatedNames.changeOperand(
                  $('_').filter($(definedFilterName).greaterThan(r(0)).simplify()),
                );
              }

              return resplitAggWithUpdatedNames;
            } else {
              const tempName = `a${i}_${c++}`;
              innerApplies.push(Expression._.apply(tempName, ex));
              outerAttributes.push(
                AttributeInfo.fromJS({
                  name: tempName,
                  type: ex.type,
                  nativeType: ex instanceof CountDistinctExpression ? 'hyperUnique' : null,
                }),
              );

              if (ex instanceof CountExpression) {
                return Expression._.sum($(tempName));
              } else if (ex instanceof ChainableUnaryExpression) {
                return ex.changeOperand(Expression._).changeExpression($(tempName));
              } else if (ex instanceof CustomAggregateExpression) {
                throw new Error('can not currently combine custom aggregation and re-split');
              } else {
                throw new Error(`bad '${ex.op}' aggregate in custom expression`);
              }
            }
          }
          return null;
        }),
      );
    });

    if (!globalResplitSplit) return null;

    const outerSplits: Splits = {};
    const innerSplits: Splits = {};

    let splitCount = 0;
    globalResplitSplit.mapSplits((name, ex) => {
      let outerSplitName = null;
      if (split) {
        split.mapSplits((name, myEx) => {
          if (ex.equals(myEx)) {
            outerSplitName = name;
          }
        });
      }

      const intermediateName = `s${splitCount++}`;
      const divvy = divvyUpNestedSplitExpression(ex, intermediateName);
      outerAttributes.push(
        AttributeInfo.fromJS({ name: intermediateName, type: divvy.inner.type }),
      );
      innerSplits[intermediateName] = divvy.inner;
      if (outerSplitName) {
        outerSplits[outerSplitName] = divvy.outer;
      }
    });

    if (split) {
      split.mapSplits((name, ex) => {
        if (outerSplits[name]) return; // already taken care of
        const intermediateName = `s${splitCount++}`;
        const divvy = divvyUpNestedSplitExpression(ex, intermediateName);
        innerSplits[intermediateName] = divvy.inner;
        outerAttributes.push(
          AttributeInfo.fromJS({ name: intermediateName, type: divvy.inner.type }),
        );
        outerSplits[name] = divvy.outer;
      });
    }

    // INNER
    const innerValue = this.valueOf();
    innerValue.mode = 'split';
    innerValue.applies = innerApplies;
    innerValue.querySelection = 'group-by-only';
    innerValue.split = split ? split.changeSplits(innerSplits) : Expression._.split(innerSplits);
    innerValue.limit = null;
    innerValue.sort = null;
    const innerExternal = new DruidExternal(innerValue);
    const innerQuery = innerExternal.getQueryAndPostTransform().query;
    delete innerQuery.context;

    // OUTER
    const outerValue = this.valueOf();
    outerValue.rawAttributes = outerAttributes;
    if (applies) {
      outerValue.applies = outerApplies;
    } else {
      outerValue.valueExpression = outerApplies[0].expression;
    }
    outerValue.filter = Expression.TRUE;
    outerValue.allowEternity = true;
    outerValue.querySelection = 'group-by-only';
    if (split) outerValue.split = split.changeSplits(outerSplits);
    const outerExternal = new DruidExternal(outerValue);

    // Put it together
    const outerQueryAndPostTransform = outerExternal.getQueryAndPostTransform();
    outerQueryAndPostTransform.query.dataSource = {
      type: 'query',
      query: innerQuery,
    };
    return outerQueryAndPostTransform;
  }

  public getQueryAndPostTransform(): QueryAndPostTransform<Druid.Query> {
    const { mode, applies, sort, limit, context, querySelection } = this;

    if (querySelection !== 'group-by-only') {
      if (
        mode === 'total' &&
        applies &&
        applies.length &&
        applies.every(apply => this.isMinMaxTimeExpression(apply.expression))
      ) {
        return this.getTimeBoundaryQueryAndPostTransform();
      } else if (mode === 'value' && this.isMinMaxTimeExpression(this.valueExpression)) {
        return this.getTimeBoundaryQueryAndPostTransform();
      }
    }

    const druidQuery: Druid.Query = {
      queryType: 'timeseries',
      dataSource: this.getDruidDataSource(),
      intervals: null,
      granularity: 'all',
    };

    const requesterContext: any = {
      timestamp: null,
      ignorePrefix: '!',
      dummyPrefix: '***',
    };

    if (context) {
      druidQuery.context = shallowCopy(context);
    }

    // Filter
    const filterAndIntervals = new DruidFilterBuilder(this).filterToDruid(this.getQueryFilter());
    druidQuery.intervals = filterAndIntervals.intervals;
    if (filterAndIntervals.filter) {
      druidQuery.filter = filterAndIntervals.filter;
    }

    let aggregationsAndPostAggregations: AggregationsAndPostAggregations;
    switch (mode) {
      case 'raw': {
        if (!this.allowSelectQueries) {
          throw new Error(
            "to issue 'scan' or 'select' queries allowSelectQueries flag must be set",
          );
        }

        const derivedAttributes = this.derivedAttributes;
        const selectedAttributes = this.getSelectedAttributes();

        const virtualColumns: Druid.VirtualColumn[] = [];
        const columns: string[] = [];
        const inflaters: Inflater[] = [];

        selectedAttributes.forEach(attribute => {
          const { name, type, nativeType } = attribute;

          if (nativeType === '__time' && name !== '__time') {
            virtualColumns.push({
              type: 'expression',
              name,
              expression: '__time',
              outputType: 'STRING',
            });
          } else {
            const derivedAttribute = derivedAttributes[name];
            if (derivedAttribute) {
              const druidExpression = new DruidExpressionBuilder(this).expressionToDruidExpression(
                derivedAttribute,
              );
              if (druidExpression === null) {
                throw new Error(`could not convert ${derivedAttribute} to Druid expression`);
              }

              virtualColumns.push({
                type: 'expression',
                name,
                expression: druidExpression,
                outputType: 'STRING',
              });
            }
          }
          columns.push(name);

          // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
          switch (type) {
            case 'BOOLEAN':
              inflaters.push(External.booleanInflaterFactory(name));
              break;

            case 'NUMBER':
              inflaters.push(External.numberInflaterFactory(name));
              break;

            case 'TIME':
              inflaters.push(External.timeInflaterFactory(name));
              break;

            case 'SET/STRING':
              inflaters.push(External.setStringInflaterFactory(name));
              break;
          }
        });

        druidQuery.queryType = 'scan';
        druidQuery.resultFormat = 'compactedList';
        if (virtualColumns.length) druidQuery.virtualColumns = virtualColumns;
        druidQuery.columns = columns;

        if (
          sort &&
          sort.refName() === this.timeAttribute &&
          this.select.attributes.includes(this.timeAttribute)
        ) {
          (druidQuery as any).order = sort.direction; // ToDo: update Druid types
          if (!druidQuery.columns.includes('__time')) {
            druidQuery.columns = druidQuery.columns.concat(['__time']);
          }
        }

        if (limit) druidQuery.limit = limit.value;

        return {
          query: druidQuery,
          context: requesterContext,
          postTransform: External.postTransformFactory(
            inflaters,
            selectedAttributes.map(a => a.dropOriginInfo()),
            null,
            null,
          ),
        };
      }

      case 'value': {
        const nestedGroupByValue = this.nestedGroupByIfNeeded();
        if (nestedGroupByValue) return nestedGroupByValue;

        aggregationsAndPostAggregations = new DruidAggregationBuilder(
          this,
        ).makeAggregationsAndPostAggregations([this.toValueApply()]);
        if (aggregationsAndPostAggregations.aggregations.length) {
          druidQuery.aggregations = aggregationsAndPostAggregations.aggregations;
        }
        if (aggregationsAndPostAggregations.postAggregations.length) {
          druidQuery.postAggregations = aggregationsAndPostAggregations.postAggregations;
        }

        if (querySelection === 'group-by-only') {
          druidQuery.queryType = 'groupBy';
          druidQuery.dimensions = [];
        }

        return {
          query: druidQuery,
          context: requesterContext,
          postTransform: External.valuePostTransformFactory(),
        };
      }

      case 'total': {
        const nestedGroupByTotal = this.nestedGroupByIfNeeded();
        if (nestedGroupByTotal) return nestedGroupByTotal;

        aggregationsAndPostAggregations = new DruidAggregationBuilder(
          this,
        ).makeAggregationsAndPostAggregations(this.applies);
        if (aggregationsAndPostAggregations.aggregations.length) {
          druidQuery.aggregations = aggregationsAndPostAggregations.aggregations;
        }
        if (aggregationsAndPostAggregations.postAggregations.length) {
          druidQuery.postAggregations = aggregationsAndPostAggregations.postAggregations;
        }

        if (querySelection === 'group-by-only') {
          druidQuery.queryType = 'groupBy';
          druidQuery.dimensions = [];
        }

        return {
          query: druidQuery,
          context: requesterContext,
          postTransform: External.postTransformFactory(
            [],
            this.getSelectedAttributes(),
            [],
            applies,
          ),
        };
      }

      case 'split': {
        const nestedGroupBy = this.nestedGroupByIfNeeded();
        if (nestedGroupBy) return nestedGroupBy;

        // Split
        const split = this.getQuerySplit();
        const splitSpec = this.splitToDruid(split);
        druidQuery.queryType = splitSpec.queryType;
        druidQuery.granularity = splitSpec.granularity;
        if (splitSpec.virtualColumns && splitSpec.virtualColumns.length)
          druidQuery.virtualColumns = splitSpec.virtualColumns;
        if (splitSpec.dimension) druidQuery.dimension = splitSpec.dimension;
        if (splitSpec.dimensions) druidQuery.dimensions = splitSpec.dimensions;
        const leftoverHavingFilter = splitSpec.leftoverHavingFilter;
        const timestampLabel = splitSpec.timestampLabel;
        requesterContext.timestamp = timestampLabel;
        const postTransform = splitSpec.postTransform;

        // Apply
        aggregationsAndPostAggregations = new DruidAggregationBuilder(
          this,
        ).makeAggregationsAndPostAggregations(applies);

        if (aggregationsAndPostAggregations.aggregations.length) {
          druidQuery.aggregations = aggregationsAndPostAggregations.aggregations;
        }

        if (aggregationsAndPostAggregations.postAggregations.length) {
          druidQuery.postAggregations = aggregationsAndPostAggregations.postAggregations;
        }

        // Combine
        switch (druidQuery.queryType) {
          case 'timeseries':
            if (sort) {
              if (!split.hasKey(sort.refName())) {
                throw new Error('can not sort within timeseries query');
              }
              if (sort.direction === 'descending') druidQuery.descending = true;
            }
            if (limit) {
              throw new Error('can not limit within timeseries query');
            }

            // Plywood's concept of splits does not allocate buckets for which there is no data.
            if (!druidQuery.context || !hasOwnProp(druidQuery.context, 'skipEmptyBuckets')) {
              druidQuery.context = druidQuery.context || {};
              druidQuery.context.skipEmptyBuckets = 'true'; // This needs to be the string "true" to work with older Druid versions
            }
            break;

          case 'topN': {
            let metric: Druid.TopNMetricSpec;
            if (sort) {
              let inverted: boolean;
              if (this.sortOnLabel()) {
                if (expressionNeedsNumericSort(split.firstSplitExpression())) {
                  metric = { type: 'dimension', ordering: 'numeric' };
                } else {
                  metric = { type: 'dimension', ordering: 'lexicographic' };
                }
                inverted = sort.direction === 'descending';
              } else {
                metric = sort.refName();
                inverted = sort.direction === 'ascending';
              }

              if (inverted) {
                metric = { type: 'inverted', metric: metric };
              }
            } else {
              metric = { type: 'dimension', ordering: 'lexicographic' };
            }
            druidQuery.metric = metric;
            druidQuery.threshold = limit ? limit.value : 1000;
            break;
          }

          case 'groupBy': {
            let orderByColumn: Druid.OrderByColumnSpecFull = null;
            if (sort) {
              const col = sort.refName();
              orderByColumn = {
                dimension: this.makeOutputName(col),
                direction: sort.direction,
              };
              if (this.sortOnLabel()) {
                if (expressionNeedsNumericSort(split.splits[col])) {
                  orderByColumn.dimensionOrder = 'numeric';
                }
              }
              druidQuery.limitSpec = {
                type: 'default',
                columns: [orderByColumn],
              };
            }

            if (limit) {
              if (!druidQuery.limitSpec) {
                druidQuery.limitSpec = {
                  type: 'default',
                  columns: [this.makeOutputName(split.firstSplitName())],
                };
              }
              druidQuery.limitSpec.limit = limit.value;
            }
            if (!leftoverHavingFilter.equals(Expression.TRUE)) {
              druidQuery.having = new DruidHavingFilterBuilder(this).filterToHavingFilter(
                leftoverHavingFilter,
              );
            }
            break;
          }
        }

        return {
          query: druidQuery,
          context: requesterContext,
          postTransform: postTransform,
        };
      }

      default:
        throw new Error(`can not get query for: ${this.mode}`);
    }
  }

  protected getIntrospectAttributes(depth: IntrospectionDepth): Promise<Attributes> {
    return DruidExternal.introspectAttributesWithSegmentMetadata(
      this.getDruidDataSource(),
      this.requester,
      this.timeAttribute,
      this.context,
      depth,
    );
  }
}

External.register(DruidExternal);
