# industry-landscape-research / scripts / Makefile
#
# 一键运行常用脚本。所有脚本均为纯标准库（python3 / bash），无 pip 依赖。
#
# 用法：
#   make validate                  # 校验 data/ 与 examples/*/ 下所有 .jsonl
#   make validate-strict           # 严格模式：缺 source/as_of/grade 直接报错
#   make unit-economics            # 计算所有 examples 的单位经济
#   make all                       # 跑完整 pipeline
#   make clean                     # 清理 build/ 输出
#
# 约定：
#   ROOT 指向 skill 包根目录（含 SKILL.md），默认就在 scripts/ 上一级。
#   BUILD 输出目录，默认 ROOT/build。

ROOT  := $(realpath $(dir $(lastword $(MAKEFILE_LIST)))/..)
BUILD := $(ROOT)/build
PY    := python3

.PHONY: help validate validate-strict unit-economics ue-md all clean

help:
	@echo "Industry Landscape Research / 脚本入口"
	@echo ""
	@echo "  make validate             校验 jsonl 结构与 datum 四元组"
	@echo "  make validate-strict      严格模式，缺数据直接 fail"
	@echo "  make unit-economics       从 examples/*/companies-sample.jsonl 计算 LTV/CAC/Payback"
	@echo "  make ue-md                同上但输出 Markdown 表"
	@echo "  make all                  validate + unit-economics"
	@echo "  make clean                清理 build/"
	@echo ""
	@echo "ROOT  = $(ROOT)"
	@echo "BUILD = $(BUILD)"

$(BUILD):
	@mkdir -p $(BUILD)

validate:
	@$(PY) $(ROOT)/scripts/validate.py --root $(ROOT)

validate-strict:
	@$(PY) $(ROOT)/scripts/validate.py --root $(ROOT) --strict

unit-economics: | $(BUILD)
	@for f in $(ROOT)/examples/*/companies-sample.jsonl; do \
	  [ -f "$$f" ] || continue; \
	  name=$$(basename $$(dirname $$f)); \
	  echo "==> $$name"; \
	  $(PY) $(ROOT)/templates/calculators/unit-economics-calculator.py \
	    --input "$$f" --output $(BUILD)/$$name-ue.csv; \
	done
	@echo "OK -> $(BUILD)/*-ue.csv"

ue-md: | $(BUILD)
	@for f in $(ROOT)/examples/*/companies-sample.jsonl; do \
	  [ -f "$$f" ] || continue; \
	  name=$$(basename $$(dirname $$f)); \
	  $(PY) $(ROOT)/templates/calculators/unit-economics-calculator.py \
	    --input "$$f" --format md > $(BUILD)/$$name-ue.md; \
	done
	@echo "OK -> $(BUILD)/*-ue.md"

all: validate unit-economics
	@echo ""
	@echo "Pipeline complete. Outputs in $(BUILD)/"

clean:
	@rm -rf $(BUILD)
	@echo "Cleaned $(BUILD)"
