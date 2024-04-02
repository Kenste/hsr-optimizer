import styled from 'styled-components'
import { Button, Flex, Form, Image, InputNumber, Modal, Radio, Select } from 'antd'
import React, { useEffect, useMemo, useState } from 'react'
import { Constants, SubStatValues } from 'lib/constants'
import { HeaderText } from './HeaderText'
import { RelicAugmenter } from 'lib/relicAugmenter'
import { Message } from 'lib/message'
import PropTypes from 'prop-types'
import { Utils } from 'lib/utils'
import { Assets } from 'lib/assets'
import { enhanceOptions, generateImageLabel, setOptions, substatOptions } from 'components/SelectOptions'

function RadioIcon(props) {
  return (
    <Radio.Button value={props.value} style={{ height: 35, width: 50, paddingLeft: 10 }}>
      <Image
        preview={false}
        width={30}
        src={props.src}
      />
    </Radio.Button>
  )
}
RadioIcon.propTypes = {
  value: PropTypes.string,
  src: PropTypes.string,
}

const InputNumberStyled = styled(InputNumber)`
  width: 90px
`

function renderMainStat(relic) {
  let mainStat = relic.main?.stat
  let mainValue = relic.main?.value

  if (!mainStat) return {}

  return renderStat(mainStat, mainValue)
}

function renderSubstat(relic, index) {
  let substat = relic.substats[index]
  if (!substat || !substat.stat) return {}

  let stat = substat.stat
  let value = substat.value

  return renderStat(stat, value)
}

function renderStat(stat, value) {
  if (Utils.isFlat(stat) && stat != Constants.Stats.SPD) {
    return {
      stat: stat,
      value: Math.floor(value),
    }
  } else {
    return {
      stat: stat,
      value: Utils.precisionRound(Math.floor(value * 10) / 10),
    }
  }
}

// onOk, setOpen, open
export default function RelicModal(props) {
  const [relicForm] = Form.useForm()
  const [mainStatOptions, setMainStatOptions] = useState([])
  const characters = window.store((s) => s.characters)

  const characterOptions = useMemo(() => Utils.generateCurrentCharacterOptions(characters), [characters])

  // Head chosen by default
  useEffect(() => {
    let defaultValues = {
      // grade: 5,
      // enhance: 15,
      part: Constants.Parts.Head,
      mainStats: [Constants.Stats.HP],
      // mainStatValue: Math.floor(Constants.MainStatsValues[Constants.Stats.HP][5]['base'] + Constants.MainStatsValues[Constants.Stats.HP][5]['increment'] * 15),
    }
    relicForm.setFieldsValue(defaultValues)
  }, [props.selectedRelic, props.open, relicForm, props])

  // selects the first main stat if the options change
  useEffect(() => {
    if (mainStatOptions.length > 0) {
      const mainStatValues = mainStatOptions.map((item) => item.value)
      relicForm.setFieldValue('mainStats', [mainStatOptions[0].value])
    }
  }, [relicForm, mainStatOptions])

  const onFinish = (x) => {
    console.log('Form finished', x)
    if (!x.part) {
      return Message.error('Part field is missing')
    }

    if (!x.set) {
      return Message.error('Set field is missing')
    }
    if (x.set.length < 1) {
      return Message.error('Choose at least one set')
    }

    if (!x.mainStats) {
      return Message.error('Main stat is missing')
    }
    if (x.mainStats.length < 1) {
      return Message.error('Choose at least one main stat')
    }

    if (!x.subStats) {
      return Message.error('Substats are missing')
    }
    if (x.subStats.length < 4) {
      return Message.error('Use at least 4 substats')
    }

    for (let set of x.set) {
      if (Constants.SetsRelicsNames.includes(set) && (x.part == Constants.Parts.PlanarSphere || x.part == Constants.Parts.LinkRope)) {
        return Message.error(`'${set}' is not an ornament set`)
      }
      if (Constants.SetsOrnamentsNames.includes(set) && (x.part == Constants.Parts.Head
        || x.part == Constants.Parts.Hands
        || x.part == Constants.Parts.Body
        || x.part == Constants.Parts.Feet)) {
        return Message.error(`'${set}' is not a relic set`)
      }
    }

    for (let mainStat of x.mainStats) {
      const subLength = x.subStats.filter(subStat => subStat !== mainStat).length
      if (subLength < 4) {
        return Message.error(`Main stat ${mainStat} does not have at least 4 available substats`)
      }
    }

    // TODO: build all relics, i.e. the bruteforce logic
    // 1. generate Substat subsets
    const subsets = []
    generateSubsets(x.subStats, 4, 0, [], subsets);
    console.log('subsets', subsets)
    // 2. generate all upgrade variation for each subset
    subsets.map(combination => combination.map((str) => ({stat: str}))
    ).forEach(combination => {
      const allUpgrades = [];
      // console.log(combination)
      assignUpgrades(combination, allUpgrades);
      // console.log('upgrades', allUpgrades)
      allUpgrades.forEach(upgrade => {
        for (let _set of x.set) {
          for (let _mainStat of x.mainStats) {
            if (overlappingStats(_mainStat, upgrade)) {
              continue
            }
            // create relic with given set etc.
            console.log("create")
            let relic = {
              equippedBy: 'None',
              enhance: 15,
              grade: 5,
              part: x.part,
              set: _set,
              main: {
                stat: _mainStat,
                value: Math.floor(Constants.MainStatsValues[_mainStat][5]['base'] + Constants.MainStatsValues[_mainStat][5]['increment'] * 15),
              },
            }
            // TODO: substats stuff
            for (let substat of upgrade) {
              substat.value = SubStatValues[substat.stat][5].high * (1 + substat.value)
            }
            relic.substats = upgrade
            RelicAugmenter.augment(relic)

            console.log('Completed relic', relic)
            DB.setRelic(relic)
          }
        }
      })
    })
    setRelicRows(DB.getRelics())
    SaveState.save()
    props.setOpen(false)
    // 3. add each upgrade variation to all relics
    return Message.error('Brute force is not yet implemented!')
    let relic = {
      equippedBy: x.equippedBy == 'None' ? undefined : x.equippedBy,
      enhance: 15,
      grade: 5,
      part: x.part,
      set: x.set,
      main: {
        stat: x.mainStatType,
        value: x.mainStatValue,
      },
    }
    // assign substats
    let substats = []
//    if (x.substatType0 != undefined && x.substatValue0 != undefined) {
//      substats.push({
//        stat: x.substatType0,
//        value: x.substatValue0,
//      })
//    }
//    if (x.substatType1 != undefined && x.substatValue1 != undefined) {
//      substats.push({
//        stat: x.substatType1,
//        value: x.substatValue1,
//      })
//    }
//    if (x.substatType2 != undefined && x.substatValue2 != undefined) {
//      substats.push({
//        stat: x.substatType2,
//        value: x.substatValue2,
//      })
//    }
//    if (x.substatType3 != undefined && x.substatValue3 != undefined) {
//      substats.push({
//        stat: x.substatType3,
//        value: x.substatValue3,
//      })
//    }
    relic.substats = substats
    RelicAugmenter.augment(relic)

    console.log('Completed relic', relic)

    props.onOk(relic)
    props.setOpen(false)
  }

  const onFinishFailed = () => {
    Message.error('Submit failed!')
    props.setOpen(false)
  }

  const onValuesChange = (x) => {
    let mainStatOptions = []
    if (x.part) {
      mainStatOptions = Object.entries(Constants.PartsMainStats[x.part]).map((entry) => ({
        label: entry[1],
        value: entry[1],
      }))
      setMainStatOptions(mainStatOptions)
      const firstMainStatValue = mainStatOptions.length > 0 ? [mainStatOptions[0]?.value] : [];
      relicForm.setFieldValue('mainStats', firstMainStatValue)
    }
    return
    let mainStatType = mainStatOptions[0]?.value || relicForm.getFieldValue('mainStats')
    let enhance = relicForm.getFieldValue('enhance')
    let grade = relicForm.getFieldValue('grade')

    if (mainStatType != undefined && enhance != undefined && grade != undefined) {
      const specialStats = [Constants.Stats.OHB, Constants.Stats.Physical_DMG, Constants.Stats.Physical_DMG, Constants.Stats.Fire_DMG, Constants.Stats.Ice_DMG, Constants.Stats.Lightning_DMG, Constants.Stats.Wind_DMG, Constants.Stats.Quantum_DMG, Constants.Stats.Imaginary_DMG]
      const floorStats = [Constants.Stats.HP, Constants.Stats.ATK, Constants.Stats.SPD]

      let mainStatValue = Constants.MainStatsValues[mainStatType][grade]['base'] + Constants.MainStatsValues[mainStatType][grade]['increment'] * enhance

      if (specialStats.includes(mainStatType)) { // Outgoing Healing Boost and elemental damage bonuses has a weird rounding with one decimal place
        mainStatValue = Utils.truncate10ths(mainStatValue)
      } else if (floorStats.includes(mainStatType)) {
        mainStatValue = Math.floor(mainStatValue)
      } else {
        mainStatValue = mainStatValue.toFixed(1)
      }
      relicForm.setFieldValue('mainStatValue', mainStatValue)
    }
  }

  const handleCancel = () => {
    props.setOpen(false)
  }
  const handleOk = () => {
    relicForm.submit()
  }

  const filterOption = (input, option) =>
    (option?.label ?? '').toLowerCase().includes(input.toLowerCase())

  return (
    <Form
      form={relicForm}
      layout="vertical"
      preserve={false}
      onFinish={onFinish}
      onFinishFailed={onFinishFailed}
      onValuesChange={onValuesChange}
    >
      <Modal
        width={350}
        centered
        destroyOnClose
        open={props.open} //
        onCancel={() => props.setOpen(false)}
        footer={[
          <Button key="back" onClick={handleCancel}>
            Cancel
          </Button>,
          <Button key="submit" type="primary" onClick={handleOk}>
            Submit
          </Button>,
        ]}
      >
        <Flex vertical gap={5}>

          <HeaderText>Part</HeaderText>

          <Form.Item size="default" name="part">
            <Radio.Group buttonStyle="solid">
              <RadioIcon value={Constants.Parts.Head} src={Assets.getPart(Constants.Parts.Head)} />
              <RadioIcon value={Constants.Parts.Hands} src={Assets.getPart(Constants.Parts.Hands)} />
              <RadioIcon value={Constants.Parts.Body} src={Assets.getPart(Constants.Parts.Body)} />
              <RadioIcon value={Constants.Parts.Feet} src={Assets.getPart(Constants.Parts.Feet)} />
              <RadioIcon value={Constants.Parts.PlanarSphere} src={Assets.getPart(Constants.Parts.PlanarSphere)} />
              <RadioIcon value={Constants.Parts.LinkRope} src={Assets.getPart(Constants.Parts.LinkRope)} />
            </Radio.Group>
          </Form.Item>

          <HeaderText>Set</HeaderText>
          <Form.Item size="default" name="set">
            <Select
              mode="multiple"
              showSearch
              allowClear
              style={{
                width: 300,
              }}
              placeholder="Sets"
              options={setOptions}
              maxTagCount="responsive"
            >
            </Select>
          </Form.Item>

          <HeaderText>Main stat</HeaderText>

          <Flex gap={10}>
            <Form.Item size="default" name="mainStats">
              <Select
                mode="multiple"
                showSearch
                style={{
                  width: 300,
                }}
                placeholder="Main Stat"
                maxTagCount="responsive"
                options={mainStatOptions}
                disabled={mainStatOptions.length <= 1}
              />
            </Form.Item>
          </Flex>

          <HeaderText>Substats</HeaderText>

          <Flex gap={10}>
            <Form.Item size="default" name="subStats">
              <Select
                mode="multiple"
                showSearch
                allowClear
                style={{
                  width: 300,
                }}
                placeholder="Substat"
                maxTagCount="responsive"
                options={substatOptions}
              />
            </Form.Item>
          </Flex>
        </Flex>
      </Modal>
    </Form>
  )
}
RelicModal.propTypes = {
  onOk: PropTypes.func,
  setOpen: PropTypes.func,
  open: PropTypes.bool,
}

function generateSubsets(arr, subsetSize, startIndex, currentSubset, result) {
  if (currentSubset.length === subsetSize) {
      result.push([...currentSubset]); // Add a copy of currentSubset to result
      return;
  }

  for (let i = startIndex; i < arr.length; i++) {
      currentSubset.push(arr[i]); // Include current element in subset
      generateSubsets(arr, subsetSize, i + 1, currentSubset, result); // Recur with next index
      currentSubset.pop(); // Backtrack: Remove last element to try other combinations
  }
}

function assignUpgrades(subStats, result, remainingUpgrades = 5, currentPoint = 0) {
  if (remainingUpgrades) {
    for (let i = currentPoint; i < subStats.length; i++) {
      const subStat = subStats[i];
        if (!subStat.value) {
          subStat.value = 0;
        }

        subStat.value++;
        assignUpgrades(subStats, result, remainingUpgrades - 1, i);
        subStat.value--;
    }
  } else {
    // add current to result
    const ret = [];
    for (let subStat of subStats) {
      const actualStat = { stat: subStat.stat, value: subStat.value ? subStat.value : 0 };
      ret.push(actualStat);
    }
    result.push(ret);
  }
}

function overlappingStats(mainStat, subStats) {
  for (let subStat of subStats) {
      if (mainStat === subStat.stat) {
          return true;
      }
  }
  return false;
}