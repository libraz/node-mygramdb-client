/**
 * Search expression parser example
 */

import {
  MygramClient,
  convertSearchExpression,
  simplifySearchExpression,
  parseSearchExpression,
  parseSearchExpressionNative
} from '../src';

async function searchExpressionExample(): Promise<void> {
  console.log('=== Search Expression Parser Examples ===\n');

  // Example 1: Simple terms
  console.log('1. Simple terms:');
  console.log('   Input: "golang tutorial"');
  console.log('   Output:', convertSearchExpression('golang tutorial'));
  console.log();

  // Example 2: Required terms
  console.log('2. Required terms:');
  console.log('   Input: "+golang +tutorial"');
  console.log('   Output:', convertSearchExpression('+golang +tutorial'));
  console.log();

  // Example 3: Excluded terms
  console.log('3. Excluded terms:');
  console.log('   Input: "+golang -old -deprecated"');
  console.log('   Output:', convertSearchExpression('+golang -old -deprecated'));
  console.log();

  // Example 4: OR expression
  console.log('4. OR expression:');
  console.log('   Input: "python OR ruby OR javascript"');
  console.log('   Output:', convertSearchExpression('python OR ruby OR javascript'));
  console.log();

  // Example 5: Grouped expression
  console.log('5. Grouped expression:');
  console.log('   Input: "+golang +(tutorial OR guide)"');
  console.log('   Output:', convertSearchExpression('+golang +(tutorial OR guide)'));
  console.log();

  // Example 6: Quoted phrase
  console.log('6. Quoted phrase:');
  console.log('   Input: \'"machine learning" tutorial\'');
  console.log('   Output:', convertSearchExpression('"machine learning" tutorial'));
  console.log();

  // Example 7: Japanese with full-width space
  console.log('7. Japanese with full-width space:');
  console.log('   Input: "機械学習　チュートリアル"');
  console.log('   Output:', convertSearchExpression('機械学習　チュートリアル'));
  console.log();

  // Example 8: Simplify for client usage
  console.log('8. Simplified for client usage:');
  const userInput = '+golang tutorial -deprecated';
  console.log(`   Input: "${userInput}"`);
  const { mainTerm, andTerms, notTerms } = simplifySearchExpression(userInput);
  console.log(`   Main term: "${mainTerm}"`);
  console.log(`   AND terms: [${andTerms.map((t) => `"${t}"`).join(', ')}]`);
  console.log(`   NOT terms: [${notTerms.map((t) => `"${t}"`).join(', ')}]`);
  console.log();

  // Example 9: Using with MygramClient
  console.log('9. Using with MygramClient:');
  const client = new MygramClient({
    host: 'localhost',
    port: 11016,
  });

  try {
    await client.connect();

    // Parse user input
    const expression = '+golang tutorial -old';
    console.log(`   User input: "${expression}"`);

    const terms = simplifySearchExpression(expression);
    console.log(`   Parsed - Main: "${terms.mainTerm}", AND: [${terms.andTerms.join(', ')}], NOT: [${terms.notTerms.join(', ')}]`);

    // Execute search
    const results = await client.search('articles', terms.mainTerm, {
      andTerms: terms.andTerms,
      notTerms: terms.notTerms,
      limit: 10,
    });

    console.log(`   Results: Found ${results.totalCount} documents`);
  } catch (error) {
    console.error('   Error:', error);
  } finally {
    client.disconnect();
  }

  // Example 10: Parse details
  console.log('\n10. Parse details:');
  const complexExpr = '+golang +(tutorial OR guide) -deprecated';
  console.log(`    Input: "${complexExpr}"`);
  const parsed = parseSearchExpression(complexExpr);
  console.log(`    Required terms: [${parsed.requiredTerms.join(', ')}]`);
  console.log(`    Optional terms: [${parsed.optionalTerms.join(', ')}]`);
  console.log(`    Excluded terms: [${parsed.excludedTerms.join(', ')}]`);
  console.log(`    Raw expression: "${parsed.rawExpression}"`);

  // Example 11: Native parser (high-performance C++ implementation)
  console.log('\n11. Native parser (C++ implementation):');
  try {
    const nativeExpr = '+golang tutorial -old -deprecated';
    console.log(`    Input: "${nativeExpr}"`);
    const nativeParsed = parseSearchExpressionNative(nativeExpr);
    console.log(`    Main term: "${nativeParsed.mainTerm}"`);
    console.log(`    AND terms: [${nativeParsed.andTerms.map((t) => `"${t}"`).join(', ')}]`);
    console.log(`    NOT terms: [${nativeParsed.notTerms.map((t) => `"${t}"`).join(', ')}]`);
    console.log(`    Optional terms: [${nativeParsed.optionalTerms.map((t) => `"${t}"`).join(', ')}]`);
    console.log('    Note: Native parser uses C++ for better performance');
  } catch (error) {
    console.log('    Native parser not available (using JavaScript fallback)');
  }

  // Example 12: Comparing native and JavaScript parsers
  console.log('\n12. Parser comparison:');
  const testExpr = '+golang tutorial -old';
  console.log(`    Input: "${testExpr}"`);

  const jsResult = simplifySearchExpression(testExpr);
  console.log(
    `    JavaScript: main="${jsResult.mainTerm}", and=[${jsResult.andTerms.join(', ')}], not=[${jsResult.notTerms.join(', ')}]`
  );

  try {
    const nativeResult = parseSearchExpressionNative(testExpr);
    console.log(
      `    Native C++: main="${nativeResult.mainTerm}", and=[${nativeResult.andTerms.join(', ')}], not=[${nativeResult.notTerms.join(', ')}]`
    );
  } catch (error) {
    console.log('    Native parser: Not available');
  }
}

// Run example
searchExpressionExample().catch(console.error);
