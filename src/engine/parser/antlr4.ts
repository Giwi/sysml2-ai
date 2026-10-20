// ESM bridge for the CommonJS `antlr4` runtime.
//
// Node's CJS named-export detection misses several antlr4 classes, so the
// generated parser (which uses named imports) cannot load `antlr4` directly.
// This shim sources the runtime through createRequire and re-exports both the
// values and their types under the names used by the generated files.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const antlr4 = require('antlr4') as typeof import('antlr4');

export const ATN = antlr4.ATN;
export const ATNDeserializer = antlr4.ATNDeserializer;
export const BailErrorStrategy = antlr4.BailErrorStrategy;
export const CharStream = antlr4.CharStream;
export const CharStreams = antlr4.CharStreams;
export const CommonTokenStream = antlr4.CommonTokenStream;
export const DecisionState = antlr4.DecisionState;
export const DFA = antlr4.DFA;
export const ErrorListener = antlr4.ErrorListener;
export const FailedPredicateException = antlr4.FailedPredicateException;
export const Interval = antlr4.Interval;
export const IntervalSet = antlr4.IntervalSet;
export const Lexer = antlr4.Lexer;
export const LexerATNSimulator = antlr4.LexerATNSimulator;
export const NoViableAltException = antlr4.NoViableAltException;
export const Parser = antlr4.Parser;
export const ParserATNSimulator = antlr4.ParserATNSimulator;
export const ParseTreeListener = antlr4.ParseTreeListener;
export const ParserRuleContext = antlr4.ParserRuleContext;
export const PredictionContextCache = antlr4.PredictionContextCache;
export const PredictionMode = antlr4.PredictionMode;
export const RecognitionException = antlr4.RecognitionException;
export const Recognizer = antlr4.Recognizer;
export const RuleContext = antlr4.RuleContext;
export const RuleNode = antlr4.RuleNode;
export const TerminalNode = antlr4.TerminalNode;
export const Token = antlr4.Token;
export const TokenStream = antlr4.TokenStream;

export type ATN = import('antlr4').ATN;
export type ATNDeserializer = import('antlr4').ATNDeserializer;
export type BailErrorStrategy = import('antlr4').BailErrorStrategy;
export type CharStream = import('antlr4').CharStream;
export type CharStreams = import('antlr4').CharStreams;
export type CommonTokenStream = import('antlr4').CommonTokenStream;
export type DecisionState = import('antlr4').DecisionState;
export type DFA = import('antlr4').DFA;
export type ErrorListener<T> = import('antlr4').ErrorListener<T>;
export type FailedPredicateException = import('antlr4').FailedPredicateException;
export type Interval = import('antlr4').Interval;
export type IntervalSet = import('antlr4').IntervalSet;
export type Lexer = import('antlr4').Lexer;
export type LexerATNSimulator = import('antlr4').LexerATNSimulator;
export type NoViableAltException = import('antlr4').NoViableAltException;
export type Parser = import('antlr4').Parser;
export type ParserATNSimulator = import('antlr4').ParserATNSimulator;
export type ParseTreeListener = import('antlr4').ParseTreeListener;
export type ParserRuleContext = import('antlr4').ParserRuleContext;
export type PredictionContextCache = import('antlr4').PredictionContextCache;
export type PredictionMode = import('antlr4').PredictionMode;
export type RecognitionException = import('antlr4').RecognitionException;
export type Recognizer<T> = import('antlr4').Recognizer<T>;
export type RuleContext = import('antlr4').RuleContext;
export type RuleNode = import('antlr4').RuleNode;
export type TerminalNode = import('antlr4').TerminalNode;
export type Token = import('antlr4').Token;
export type TokenStream = import('antlr4').TokenStream;
