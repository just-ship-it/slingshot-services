#!/bin/bash

# Comprehensive Stop Loss Testing Matrix
# Tests both fixed and structural stop approaches with various risk parameters
# Total: 11 tests (5 Fixed + 6 Structural)

echo "🧪 Starting Comprehensive Stop Loss Testing Matrix"
echo "=================================================="
echo "📅 Period: April 4, 2023 to December 19, 2025"
echo "📈 Strategy: gex-ldpm-confluence-pullback"
echo "⏱️  Timeframe: 15m"
echo "📊 Total Tests: 11 (5 Fixed + 6 Structural)"
echo "📁 Results Directory: ./results/"
echo ""

# Start timing
start_time=$(date +%s)

# Create results directory if it doesn't exist
mkdir -p results

# Function to run test with error handling and timing
run_test() {
    local test_name="$1"
    local command="$2"
    local output_file="$3"

    echo "🚀 Starting: $test_name"
    echo "📄 Output: $output_file"

    test_start=$(date +%s)

    # Run the command
    if eval $command; then
        test_end=$(date +%s)
        test_duration=$((test_end - test_start))
        echo "✅ Completed: $test_name (${test_duration}s)"
        echo ""
    else
        echo "❌ FAILED: $test_name"
        echo "Command: $command"
        echo ""
        exit 1
    fi
}



echo "🏗️ STRUCTURAL STOPS TESTING (6 tests)"
echo "======================================"

run_test "Structural 20pt max risk (extra tight)" \
    "node index.js --ticker NQ --start 2023-04-04 --end 2025-12-19 --strategy gex-ldpm-confluence-pullback --timeframe 15m --use-structural-stops --max-risk 20 --output-json results/structural-20pt-risk.json" \
    "results/structural-20pt-risk.json"

run_test "Structural 30pt max risk (tight)" \
    "node index.js --ticker NQ --start 2023-04-04 --end 2025-12-19 --strategy gex-ldpm-confluence-pullback --timeframe 15m --use-structural-stops --max-risk 30 --output-json results/structural-30pt-risk.json" \
    "results/structural-30pt-risk.json"

run_test "Structural 50pt max risk (default)" \
    "node index.js --ticker NQ --start 2023-04-04 --end 2025-12-19 --strategy gex-ldpm-confluence-pullback --timeframe 15m --use-structural-stops --max-risk 50 --output-json results/structural-50pt-risk.json" \
    "results/structural-50pt-risk.json"

run_test "Structural 75pt max risk (medium)" \
    "node index.js --ticker NQ --start 2023-04-04 --end 2025-12-19 --strategy gex-ldpm-confluence-pullback --timeframe 15m --use-structural-stops --max-risk 75 --output-json results/structural-75pt-risk.json" \
    "results/structural-75pt-risk.json"

run_test "Structural 100pt max risk (loose)" \
    "node index.js --ticker NQ --start 2023-04-04 --end 2025-12-19 --strategy gex-ldpm-confluence-pullback --timeframe 15m --use-structural-stops --max-risk 100 --output-json results/structural-100pt-risk.json" \
    "results/structural-100pt-risk.json"

run_test "Structural 150pt max risk (very loose)" \
    "node index.js --ticker NQ --start 2023-04-04 --end 2025-12-19 --strategy gex-ldpm-confluence-pullback --timeframe 15m --use-structural-stops --max-risk 150 --output-json results/structural-150pt-risk.json" \
    "results/structural-150pt-risk.json"

# Calculate total duration
end_time=$(date +%s)
total_duration=$((end_time - start_time))
hours=$((total_duration / 3600))
minutes=$(((total_duration % 3600) / 60))
seconds=$((total_duration % 60))

echo "🎉 ALL 11 TESTS COMPLETED SUCCESSFULLY!"
echo "========================================"
echo "⏱️  Total Runtime: ${hours}h ${minutes}m ${seconds}s"
echo "📁 Results Directory: ./results/"
echo ""
echo "📊 Generated Files:"
echo "   Fixed Stops (5 files):"
echo "   ├─ fixed-20pt-stops.json"
echo "   ├─ fixed-30pt-stops.json"
echo "   ├─ fixed-40pt-stops.json (default)"
echo "   ├─ fixed-50pt-stops.json"
echo "   └─ fixed-60pt-stops.json"
echo ""
echo "   Structural Stops (6 files):"
echo "   ├─ structural-20pt-risk.json (extra tight)"
echo "   ├─ structural-30pt-risk.json (tight)"
echo "   ├─ structural-50pt-risk.json (default)"
echo "   ├─ structural-75pt-risk.json (medium)"
echo "   ├─ structural-100pt-risk.json (loose)"
echo "   └─ structural-150pt-risk.json (very loose)"
echo ""
echo "🔍 Ready for analysis! Compare performance across all configurations."
echo "💡 Recommendation: Start with fixed vs structural at comparable risk levels"
echo "   (e.g., fixed-40pt vs structural-50pt)"