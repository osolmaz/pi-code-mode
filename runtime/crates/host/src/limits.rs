use pi_code_mode_protocol::{ErrorCode, ExecutionOptions, ProtocolError};
use pi_code_mode_runtime::RuntimeLimits;

pub const MAX_SOURCE_BYTES: usize = 64 * 1024;
pub const MAX_HEAP_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 128 * 1024;
pub const MAX_TOOL_CALLS: u32 = 64;
pub const MAX_CONCURRENT_TOOL_CALLS: u32 = 8;
pub const MAX_TOOL_INPUT_BYTES: usize = 256 * 1024;
pub const MAX_TOOL_RESULT_BYTES: usize = 1024 * 1024;
pub const MAX_TOTAL_TOOL_RESULT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_STORE_BYTES: usize = 1024 * 1024;
pub const MAX_TIMER_MS: u64 = 5 * 60 * 1000;
pub const MAX_TIMERS: u32 = 64;
pub const MAX_CPU_LIMIT_MS: u64 = 5_000;
pub const MAX_WALL_TIME_MS: u64 = 5 * 60 * 1000;
pub const MAX_YIELD_TIME_MS: u64 = 30 * 60 * 1000;

pub fn runtime_limits(options: &ExecutionOptions) -> Result<RuntimeLimits, ProtocolError> {
    bounded(options.max_source_bytes, MAX_SOURCE_BYTES, "maxSourceBytes")?;
    bounded(options.max_heap_bytes, MAX_HEAP_BYTES, "maxHeapBytes")?;
    bounded(options.max_output_bytes, MAX_OUTPUT_BYTES, "maxOutputBytes")?;
    bounded(options.max_tool_calls, MAX_TOOL_CALLS, "maxToolCalls")?;
    bounded(
        options.max_concurrent_tool_calls,
        MAX_CONCURRENT_TOOL_CALLS,
        "maxConcurrentToolCalls",
    )?;
    bounded(
        options.max_tool_input_bytes,
        MAX_TOOL_INPUT_BYTES,
        "maxToolInputBytes",
    )?;
    bounded(
        options.max_tool_result_bytes,
        MAX_TOOL_RESULT_BYTES,
        "maxToolResultBytes",
    )?;
    bounded(
        options.max_total_tool_result_bytes,
        MAX_TOTAL_TOOL_RESULT_BYTES,
        "maxTotalToolResultBytes",
    )?;
    bounded(options.max_store_bytes, MAX_STORE_BYTES, "maxStoreBytes")?;
    bounded(options.max_timer_ms, MAX_TIMER_MS, "maxTimerMs")?;
    bounded(options.max_timers, MAX_TIMERS, "maxTimers")?;
    bounded(options.cpu_limit_ms, MAX_CPU_LIMIT_MS, "cpuLimitMs")?;
    bounded(options.wall_time_ms, MAX_WALL_TIME_MS, "wallTimeMs")?;
    bounded(options.yield_time_ms, MAX_YIELD_TIME_MS, "yieldTimeMs")?;
    Ok(RuntimeLimits {
        max_heap_bytes: options.max_heap_bytes,
        max_output_bytes: options.max_output_bytes,
        max_tool_calls: options.max_tool_calls,
        max_concurrent_tool_calls: options.max_concurrent_tool_calls,
        max_tool_input_bytes: options.max_tool_input_bytes,
        max_tool_result_bytes: options.max_tool_result_bytes,
        max_total_tool_result_bytes: options.max_total_tool_result_bytes,
        max_store_bytes: options.max_store_bytes,
        max_timer_ms: options.max_timer_ms,
        max_timers: options.max_timers,
        cpu_limit_ms: options.cpu_limit_ms,
    })
}

pub fn validate_observation(
    yield_time_ms: u64,
    max_output_bytes: usize,
) -> Result<(), ProtocolError> {
    if yield_time_ms > MAX_YIELD_TIME_MS {
        return Err(invalid_limit("yieldTimeMs"));
    }
    bounded(max_output_bytes, MAX_OUTPUT_BYTES, "maxOutputBytes")
}

fn bounded<T>(value: T, maximum: T, name: &str) -> Result<(), ProtocolError>
where
    T: Copy + Default + PartialEq + PartialOrd,
{
    if value == T::default() || value > maximum {
        return Err(invalid_limit(name));
    }
    Ok(())
}

fn invalid_limit(name: &str) -> ProtocolError {
    ProtocolError::new(
        ErrorCode::InvalidInput,
        format!("{name} is outside the supported range"),
    )
}
